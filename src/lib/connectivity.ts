import { useEffect, useRef, useSyncExternalStore } from 'react'
import Constants from 'expo-constants'

/**
 * App-wide "can we reach the server" signal, observed from the request layer.
 *
 * WHY NOT A CONNECTIVITY LIBRARY: @react-native-community/netinfo and
 * expo-network are both NATIVE modules and neither is installed. Adding one
 * changes the fingerprint, which orphans every installed build from OTA until a
 * new binary ships (see .claude/notes/ota-updates-expo-updates.md). It would
 * also answer a subtly different question — "is an interface up", which is true
 * on a captive-portal wifi that reaches nothing. What the app actually needs to
 * know is whether its requests are arriving, and the requests already say so.
 *
 * The observation point is `timeoutFetch`, which supabase-js is given as
 * `global.fetch`, so it sees auth, PostgREST, Storage and Edge Functions —
 * every call the app makes to the backend, through one function.
 *
 * NOT a replacement for handling a failed call where it happens. This drives a
 * banner and a reconcile-on-recovery pass; a screen that needs to tell the user
 * its own write failed still has to do that itself.
 */

type Listener = () => void

let online = true
const listeners = new Set<Listener>()
const recoveryListeners = new Set<Listener>()
let probeTimer: ReturnType<typeof setInterval> | null = null

function emit() {
  for (const l of listeners) l()
}

/**
 * Is this failure "the request could not leave the phone" rather than "the
 * server said no"?
 *
 * Lives here rather than in AuthContext (its first home) so the launch gate and
 * the in-app banner classify identically. Two copies of this would drift, and
 * the drift would be silent — each side would just be wrong about a different
 * subset of failures.
 *
 * React Native's fetch rejects with `TypeError: Network request failed` when
 * there is no connectivity. `AbortError` counts because timeoutFetch's ceiling
 * only fires on a socket that is never going to answer, which the user
 * experiences as the same condition with the same fix. Note postgrest-js
 * composes its message as `${name}: ${message}`, so both shapes arrive here as
 * text and are matched as text.
 */
export function isNetworkError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  const msg = String(e?.message ?? err ?? '').toLowerCase()
  return (
    e?.name === 'AbortError' ||
    msg.includes('network request failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('aborted')
  )
}

/**
 * ANY resolved response means online — a 500 or a 403 included. The question
 * being answered is "did the request reach the server", not "did the server
 * like it". Gating recovery on a 2xx would keep the banner up through an
 * ordinary RLS denial, which is both wrong and unfixable by the user.
 */
export function markOnline() {
  if (online) return
  online = true
  stopProbe()
  emit()
  // Recovery listeners fire AFTER the flag flips, so anything they trigger
  // reads the new state rather than racing it.
  for (const l of recoveryListeners) l()
}

export function markOffline() {
  if (!online) return
  online = false
  startProbe()
  emit()
}

export function getIsOnline() {
  return online
}

function subscribe(l: Listener) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * While offline the app makes no requests, so without this the banner would
 * stay up until the user happened to tap something — the same dead end as the
 * launch spinner, one screen over.
 *
 * `/auth/v1/health` is unauthenticated, tiny, and cheap enough to poll. It uses
 * the RAW fetch on purpose: routing it through timeoutFetch would let the probe
 * mark its own result, and a probe that can mark OFFLINE keeps itself alive
 * forever on a URL that may be wrong. This one can only ever mark online — real
 * traffic is the only thing allowed to declare a problem.
 */
function startProbe() {
  if (probeTimer) return
  const url = Constants.expoConfig?.extra?.supabaseUrl
  if (!url) return
  probeTimer = setInterval(() => {
    fetch(`${url}/auth/v1/health`)
      .then(() => markOnline())
      .catch(() => {
        /* still down; the next tick tries again */
      })
  }, 5000)
}

function stopProbe() {
  if (!probeTimer) return
  clearInterval(probeTimer)
  probeTimer = null
}

/** `true` while requests are reaching the backend. */
export function useConnectivity() {
  return useSyncExternalStore(subscribe, getIsOnline, getIsOnline)
}

/**
 * Run `cb` on each offline→online edge.
 *
 * This is the half that matters more than the banner. Realtime's
 * `postgres_changes` does NOT replay events missed while the socket was down,
 * so any row that changed during the gap is silently stale in local state —
 * including `drivers.is_active`, which the 5-minute reaper flips on exactly the
 * device that cannot hear about it. Consumers use this to re-read from the
 * server rather than trust a subscription that was not listening.
 *
 * The callback is held in a ref so a caller can pass an inline closure without
 * resubscribing on every render.
 */
export function useOnReconnect(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const l = () => ref.current()
    recoveryListeners.add(l)
    return () => {
      recoveryListeners.delete(l)
    }
  }, [])
}
