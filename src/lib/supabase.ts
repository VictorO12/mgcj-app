import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'
import { AppState } from 'react-native'

const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl
const supabaseAnonKey = Constants.expoConfig?.extra?.supabaseAnonKey

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

// autoRefreshToken alone is not enough in React Native: the refresh timer does
// not survive backgrounding, so a phone left idle wakes with a stale access
// token while the app still looks signed in. Code paths that go through
// supabase-js often paper over it, but anything that reads
// session.access_token and builds its own fetch — create-payment-intent in
// PassengerHomeScreen — sends the stale token and gets a 401 the passenger
// reads as "payment failed". Observed 2026-08-13: a booking succeeded at
// 02:09 UTC and the same build 401'd at 02:38 after the phone sat idle.
//
// Tie the refresh loop to foreground/background, per Supabase's RN guidance.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh()
  } else {
    supabase.auth.stopAutoRefresh()
  }
})

// AppState only fires on change, so the very first foreground needs starting
// by hand — otherwise the loop stays idle until the app is backgrounded once.
if (AppState.currentState === 'active') {
  supabase.auth.startAutoRefresh()
}
