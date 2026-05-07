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

export function useNotifications() {
  const { profile } = useAuth()
  const notificationListener = useRef<any>()
  const responseListener = useRef<any>()

  useEffect(() => {
    if (!profile || profile.role !== 'driver') return
    registerForPushNotifications()
  }, [profile])

  async function registerForPushNotifications() {
    const { status: existing } = await Notifications.getPermissionsAsync()
    let finalStatus = existing

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync()
      finalStatus = status
    }

    if (finalStatus !== 'granted') {
      console.log('Push notification permission denied')
      return
    }

    // Register notification categories for Accept/Decline buttons
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

    // Get push token
    const token = await Notifications.getExpoPushTokenAsync({
      projectId: '1df2c110-8290-4853-9574-2fe4b71799b0', // replace with yours
    })

    console.log('Push token:', token.data)

    // Save token to Supabase
    if (profile?.id) {
      await supabase
        .from('drivers')
        .update({ push_token: token.data })
        .eq('id', profile.id)
    }

    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('rides', {
        name: 'Ride requests',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
      })
    }
  }

  return { notificationListener, responseListener }
}