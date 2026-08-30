import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'
import { AppState } from 'react-native'
import { timeoutFetch } from './timeoutFetch'
import * as bootTrace from './bootTrace'

// Marks when this module finished evaluating. A large gap between "react
// mounted" and this one means the delay is JS bundle startup / import chain,
// not the auth client — the one cause the network and storage spans cannot
// distinguish, because neither has been reached yet.
bootTrace.mark('supabase.ts loaded')

const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl
const supabaseAnonKey = Constants.expoConfig?.extra?.supabaseAnonKey

// expo-secure-store warns (JS-side, both platforms) above 2048 bytes and its
// own message says a future SDK "may throw". It does NOT truncate today: on
// Android the value goes through AESEncryptor into
// SharedPreferences.putString, which has no per-string cap, and on iOS into
// the Keychain. So an oversized session is a forward-compatibility risk, not a
// live corruption risk — but if that write ever starts throwing, supabase-js
// gets a rejected setItem, the session never persists, and the app becomes a
// login loop. Measure it rather than assume: log the byte length (never the
// value — it is a live access + refresh token) on every persist in dev.
//
// Counted by hand rather than with TextEncoder: this probe runs *before* the
// write, so anything it throws stops the session persisting — it would cause
// the very login loop it exists to rule out. TextEncoder's presence is a
// Hermes-runtime question that a typecheck does not answer, so don't depend on
// it, and keep the whole call in a try/catch for the same reason.
const utf8Bytes = (value: string) => {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4
        i++
        continue
      }
    }
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return bytes
}

// Byte budget only — never log a value. The persisted session is a live
// access/refresh token pair; the whole point is to size it, not to expose it.
// The limit is expo-secure-store's VALUE_BYTES_LIMIT (2048), tripped on
// `bytes > 2048`. It only console.warns today, but the warning says a future
// SDK may throw, and that WOULD be the login loop this exists to rule out.
const measure = (key: string, value: string) => {
  if (!__DEV__) return
  const bytes = utf8Bytes(value)
  const slack = 2048 - bytes
  console.log(
    `[SecureStore] ${key}: ${bytes} bytes` +
      (bytes > 2048
        ? ' — OVER the 2048-byte limit'
        : ` — ${slack} bytes of headroom`)
  )

  // Where the budget goes, so we know what would push it over.
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return
    const parts: string[] = []
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'user') continue
      parts.push(`${k}=${utf8Bytes(typeof v === 'string' ? v : JSON.stringify(v))}`)
    }
    const user = (parsed as Record<string, unknown>).user
    if (user && typeof user === 'object') {
      const u = user as Record<string, unknown>
      parts.push(`user=${utf8Bytes(JSON.stringify(u))}`)
      for (const k of ['email', 'phone', 'identities', 'user_metadata', 'app_metadata']) {
        if (u[k] === undefined) continue
        const size = utf8Bytes(
          typeof u[k] === 'string' ? (u[k] as string) : JSON.stringify(u[k])
        )
        parts.push(`  user.${k}=${size}`)
      }
    }
    console.log(`[SecureStore] breakdown: ${parts.join(' ')}`)
  } catch {
    // A non-JSON value is fine — the total above is the number that matters.
  }
}

const ExpoSecureStoreAdapter = {
  // Timed because this is the ONE await on the launch path that is not a
  // network call, and it is awaited BEFORE any request is issued
  // (`_recoverAndRefresh` reads storage first). If the trace shows this span
  // taking tens of seconds while the fetch that follows is fast, the whole
  // network theory is wrong and the cause is the iOS Keychain — which would
  // also explain why it is reported as worse on iOS, and why a fetch ceiling
  // did nothing.
  getItem: (key: string) => {
    bootTrace.spanStart(`storage.get ${key}`)
    return SecureStore.getItemAsync(key)
      .then((v) => {
        // Length, never the value — this is a live access + refresh token pair.
        bootTrace.spanEnd(`storage.get ${key}`, v ? `${v.length} chars` : 'null')
        return v
      })
      .catch((err) => {
        bootTrace.spanEnd(`storage.get ${key}`, `THREW: ${String(err).slice(0, 80)}`)
        throw err
      })
  },
  setItem: (key: string, value: string) => {
    try {
      measure(key, value)
    } catch {
      // Instrumentation must never be able to block a session write.
    }
    return SecureStore.setItemAsync(key, value)
  },
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  // Load-bearing, not a tuning knob. auth-js has NO timeout on its own fetch,
  // so a stalled /auth/v1/token during client init leaves `initializePromise`
  // unsettled forever — which hangs `getSession()` AND the INITIAL_SESSION
  // emit, i.e. every exit from the app's loading gate at once. See
  // ./timeoutFetch.ts for the full trace and why removing this reintroduces a
  // launch hang that only a force-quit clears.
  //
  // Verified this actually reaches the auth client: supabase-js threads
  // `global.fetch` into `_initSupabaseAuthClient`, so it covers auth, PostgREST
  // and storage. The wrapper itself decides which of those it applies to.
  global: { fetch: timeoutFetch },
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
