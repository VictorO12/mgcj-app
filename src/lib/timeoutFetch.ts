/**
 * A `fetch` that is guaranteed to settle.
 *
 * READ THIS FIRST, because the theory this file was originally written to fix
 * was WRONG. It is kept as a backstop and it did NOT fix the launch hang.
 *
 * The original claim was that a stalled POST /auth/v1/token left auth-js's
 * `initializePromise` unsettled. That was reasoned from the code and never
 * measured. On-device tracing falsified it on 2026-08-29: the refresh returned
 * HTTP 200 in 871ms and every Keychain read was under 10ms, yet the app hung
 * indefinitely with the profile query open and no request ever issued.
 *
 * The real cause was a deadlock, not latency — `_notifyAllSubscribers` awaits
 * each `onAuthStateChange` callback, and the app's callback awaited a PostgREST
 * query that awaited the very `initializePromise` blocked on the callback. The
 * fix lives in src/hooks/AuthContext.tsx; see the comment on the subscription.
 *
 * Two lessons, each of which cost a build cycle:
 *
 * 1. A timeout cannot break a deadlock. The cycle is entirely in-process and no
 *    request is in flight, so every ceiling added here was inert against the
 *    actual bug. "Never settles" is not automatically a network property.
 * 2. `_refreshAccessToken` wraps its fetch in a retry ladder bounded by 30s of
 *    WALL CLOCK, and an abort is classified as `AuthRetryableFetchError`
 *    (auth-js lib/fetch.js:124) — the exact class it retries. So any ceiling
 *    below 30s silently doubles itself: 20s produced two attempts, ~41s total.
 *
 * Why it still earns its place: a genuinely wedged connection — no response, no
 * error — has no other ceiling anywhere in auth-js's fetch layer, which
 * contains neither a timeout nor an AbortSignal. Rare, never the reported bug,
 * but real and otherwise unbounded.
 *
 * An aborted refresh is safe and is not a logout: the abort surfaces as a
 * retryable fetch error, and `_callRefreshToken` only calls `_removeSession()`
 * when the error is NOT retryable. The session survives, and the app launches
 * on a stale access token that autoRefresh retries.
 */

/**
 * Scoped to auth and PostgREST ON PURPOSE — do not widen this to every request.
 *
 * These are the two doors the launch path goes through (`/auth/v1/token` during
 * client init, `/rest/v1/profiles` in `fetchProfile`), and both are sub-second
 * operations in normal use, so a ceiling is unambiguously a fault signal.
 *
 * `/functions/v1/` and `/storage/v1/` are deliberately EXCLUDED: Edge Functions
 * legitimately run long (`edit-ride` makes a Directions call and a Stripe round
 * trip in one request; `capture-payment` waits on Stripe), and an avatar upload
 * is as slow as the user's uplink. Putting a 20s guillotine on those would turn
 * a launch fix into a payment bug.
 */
const shouldTimeout = (url: string) =>
  url.includes('/auth/v1/') || url.includes('/rest/v1/')

/**
 * Generous by design. This is a deadlock breaker for a wedged socket, not a
 * latency budget — it should only ever fire on a connection that is never going
 * to answer, never on a slow one. A number tight enough to trip on bad cellular
 * would abort working requests, which is worse than the case it guards.
 *
 * See lesson 2 above before lowering this: below 30s the auth retry ladder
 * doubles whatever value is set here.
 */
const REQUEST_TIMEOUT_MS = 20000

export const timeoutFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url

  if (!shouldTimeout(url)) return fetch(input, init)

  const controller = new AbortController()
  const timer = setTimeout(() => {
    // Aborting produces a rejection, which every caller above already handles.
    // The point is to convert "hangs forever" into "fails", because the codebase
    // has handling for failure and none at all for silence.
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  // Respect a caller-supplied signal rather than discarding it: dropping it
  // would silently break any future cancellation the app does itself.
  const upstream = init?.signal
  if (upstream) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener('abort', () => controller.abort())
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer)
  })
}
