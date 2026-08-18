import { useEffect, useRef } from 'react'
import * as Notifications from 'expo-notifications'
import { AppState, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
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

// The last push token THIS device wrote, so we can clear it by value rather than
// by user id. Nulling by user id would be wrong: a passenger can be signed in on
// two phones (there is no single-device lock outside the driver device_token),
// so clearing "this user's token" could wipe the other phone's working token.
// Same by-value discipline the server-side retire_push_token uses.
const LAST_TOKEN_KEY = 'push_token_last_written'

/**
 * Clears this device's token from the DB when we know push can no longer work
 * here — i.e. the OS permission has been turned off. Without this the row keeps
 * a token that looks valid: the passenger is skipped for SMS fallback (which
 * keys off push_token being null) while the push itself goes nowhere, and a
 * driver keeps passing isDriverDispatchable() and absorbing ride offers.
 *
 * The server-side receipt poller catches this too, but only after a wasted push
 * plus Expo's ~15-minute receipt delay. This catches it at the next app open.
 */
async function clearOwnPushToken(profile: { id: string; role?: string | null }) {
  const last = await AsyncStorage.getItem(LAST_TOKEN_KEY)
  if (!last) return
  if (profile.role === 'driver') {
    await supabase.from('drivers')
      .update({ push_token: null })
      .eq('id', profile.id).eq('push_token', last)
  }
  await supabase.from('profiles')
    .update({ push_token: null })
    .eq('id', profile.id).eq('push_token', last)
  await AsyncStorage.removeItem(LAST_TOKEN_KEY)
  console.log('[push] permission gone — cleared this device\'s token')
}

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
    // Don't just decline to write — actively retire whatever this device left
    // behind, or a stale token keeps us believing push works here.
    await clearOwnPushToken(profile).catch((e) =>
      console.warn('[push] clearOwnPushToken failed:', e),
    )
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

  // Remember it so a later permission-revocation can clear by value (see above).
  await AsyncStorage.setItem(LAST_TOKEN_KEY, token)

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

/**
 * Cheap freshness check, run when the app comes to the foreground. Unlike
 * registerPushToken this NEVER prompts — it only reconciles what the device
 * currently has against what the DB holds.
 *
 * Why it's needed: registration is guarded to once per session
 * (`registeredForRef`), so a cold start re-registers but a foreground resume
 * does not. A token that rotated, or a permission re-granted while the app was
 * backgrounded, would otherwise go unnoticed until the app was killed.
 *
 * Multi-device note: with a single push_token column, two signed-in phones mean
 * the most recently foregrounded one owns pushes. That's the intended product
 * answer (pushes follow the phone you're actually using) and it's bounded by
 * user action, not a loop — useNotifications' effect depends on `profile?.id`,
 * so writing push_token does not re-trigger registration. If multi-device ever
 * needs to work properly, the real fix is a push_tokens child table (one row per
 * device, send to all), not more logic here.
 */
export async function syncPushToken(
  profile: { id: string; role?: string | null } | null | undefined,
): Promise<void> {
  if (!profile?.id) return

  const { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted') {
    await clearOwnPushToken(profile)
    return
  }

  let token: string
  try {
    const result = await Notifications.getExpoPushTokenAsync({
      projectId: '1df2c110-8290-4853-9574-2fe4b71799b0',
    })
    token = result.data
  } catch {
    return // Expo Go on Android SDK 53+, etc. Nothing to reconcile.
  }

  const { data: row } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', profile.id)
    .maybeSingle()

  if (row?.push_token === token) return

  if (profile.role === 'driver') {
    await supabase.from('drivers').update({ push_token: token }).eq('id', profile.id)
  }
  await supabase.from('profiles').update({ push_token: token }).eq('id', profile.id)
  await AsyncStorage.setItem(LAST_TOKEN_KEY, token)
  console.log('[push] token refreshed on foreground')
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

  // Reconcile on every return to the foreground — see syncPushToken. Registration
  // above only runs once per session, so this is what notices a rotated token or
  // a permission changed in OS settings while we were backgrounded.
  useEffect(() => {
    if (!profile?.id) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncPushToken(profile).catch((e) => console.warn('[push] sync failed:', e))
      }
    })
    return () => sub.remove()
  }, [profile?.id])

  return { notificationListener, responseListener }
}