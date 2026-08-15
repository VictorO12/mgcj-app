import { useEffect, useRef } from 'react'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

// Configure how notifications appear when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

// Registers for push and persists the token. Exported standalone (not just used
// by the hook) so the driver go-online toggle can require a working token before
// flipping is_active — a driver with no push_token is filtered out of dispatch by
// assign-ride, so "online" without one is a lie: they'd sit all shift and never
// be offered a ride, with nothing telling them why.
//
// Returns the token, or null with a reason the caller can surface.
export async function registerPushToken(
  profile: { id: string; role?: string | null } | null | undefined,
): Promise<{ token: string | null; reason: 'denied' | 'unavailable' | null }> {
  if (!profile?.id) return { token: null, reason: 'unavailable' }

  const { status: existing } = await Notifications.getPermissionsAsync()
  let finalStatus = existing

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission denied')
    return { token: null, reason: 'denied' }
  }

  // Drivers get Accept/Decline action buttons — passengers get standard notifications
  if (profile.role === 'driver') {
    await Notifications.setNotificationCategoryAsync('RIDE_REQUEST', [
      {
        identifier: 'ACCEPT',
        buttonTitle: '✓ Accept',
        options: { opensAppToForeground: true },
      },
      {
        identifier: 'DECLINE',
        buttonTitle: '✗ Decline',
        options: { opensAppToForeground: false, isDestructive: true },
      },
    ])
  }

  // Can throw rather than reject softly — notably Expo Go on Android SDK 53+,
  // where push isn't supported at all. Treat as "no token", not a crash.
  let token: string
  try {
    const result = await Notifications.getExpoPushTokenAsync({
      projectId: '1df2c110-8290-4853-9574-2fe4b71799b0',
    })
    token = result.data
  } catch (e) {
    console.warn('[push] getExpoPushTokenAsync failed:', e)
    return { token: null, reason: 'unavailable' }
  }

  // Save token — drivers → drivers table, passengers → profiles table
  if (profile.role === 'driver') {
    await supabase.from('drivers').update({ push_token: token }).eq('id', profile.id)
  }

  // Everyone gets it on profiles (used by notify-passenger)
  await supabase.from('profiles').update({ push_token: token }).eq('id', profile.id)

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('rides', {
      name: 'Ride updates',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    })
  }

  return { token, reason: null }
}

export function useNotifications() {
  const { profile } = useAuth()
  const notificationListener = useRef<any>()
  const responseListener = useRef<any>()
  const registeredForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!profile?.id) return
    // Guard: only register once per user session, not on every profile update.
    // Writing push_token to profiles triggers the realtime profile subscription
    // which would cause an infinite re-registration loop otherwise.
    if (registeredForRef.current === profile.id) return
    registeredForRef.current = profile.id
    registerPushToken(profile)
  }, [profile?.id])

  return { notificationListener, responseListener }
}