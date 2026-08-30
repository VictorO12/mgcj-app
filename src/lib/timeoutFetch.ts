/**
 * A `fetch` that is guaranteed to settle.
 *
 * READ THIS FIRST: the theory this file was originally written to fix was
 * WRONG, and it is kept only as a backstop. It does not fix the launch hang.
 *
 * The original claim here was that a stalled POST /auth/v1/token left auth-js's
 * `initializePromise` unsettled. That was reasoned from the code and never
 * measured. It was falsified on 2026-08-29 by an on-device trace: the refresh
 * returned **HTTP 200 in 871ms** and every Keychain read was under 10ms, yet the
 * app hung indefinitely with the profile query open and no request ever issued.
 *
 * The real cause was a deadlock, not latency: `_notifyAllSubscribers` awaits
 * each `onAuthStateChange` callback, and the app's callback awaited a PostgREST
 * query, which awaited the very `initializePromise` that was blocked on the
 * callback. See the long comment on the subscription in
 * src/hooks/AuthContext.tsx — that is where the fix lives.
 *
 * Two lessons worth keeping, because both cost a build cycle:
 *
 * 1. A timeout cannot break a deadlock. The cycle is entirely in-process; no
 *    request is in flight to time out. Every ceiling added here was inert
 *    against the actual bug.
 * 2. `_refreshAccessToken` wraps its fetch in a retry ladder bounded by 30s of
 *    WALL CLOCK, and an abort is classified as `AuthRetryableFetchError`
 *    (lib/fetch.js:124) — the exact class it retries. So a ceiling below 30s
 *    silently doubles itself. If this value is ever lowered again, keep that in
 *    mind: 20s here produced two attempts and ~41s of waiting.
 *
 * What it is still worth keeping for: a genuinely wedged connection (no
 * response, no error) has no other ceiling anywhere in auth-js's fetch layer —
 * `lib/fetch.js` contains neither a timeout nor an AbortSignal. That case is
 * rare and was never the reported bug, but it is real and unbounded without
 * this.
 *
 * An aborted refresh is safe and is not a logout: the abort surfaces as a
 * retryable fetch error, `_callRefreshToken` catches it, and `_recoverAndRefresh`
 * preserves the session on a retryable failure (proactive-preserve). The app
 * launches signed in on a stale access token that autoRefresh retries.
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
import * as bootTrace from './bootTrace'

const shouldTimeout = (url: string) =>
  url.includes('/auth/v1/') || url.includes('/rest/v1/')

/**
 * Generous by design. This is a deadlock breaker, not a latency budget — it
 * should only ever fire on a genuinely wedged connection, never on a slow one.
 * A number tight enough to trip on bad cellular would log people out of a
 * working app, which is a worse bug than the one being fixed.
 */
/**
 * RAISED FROM 20000 TO 45000 FOR THE DIAGNOSTIC BUILD. Revert once measured.
 *
 * 20s was actively preventing the measurement. Two reasons:
 *
 * 1. A ceiling BELOW the true latency reports every slow request as identical
 *    ("aborted at 20s"), so a request that really takes 25s and one that would
 *    never complete look the same — and those need opposite fixes.
 * 2. It sat below auth-js's retry ladder. `_refreshAccessToken` retries while
 *    `Date.now() + nextBackOff - startedAt < 30000`, and an abort is classified
 *    as `AuthRetryableFetchError` (lib/fetch.js:124), which is exactly the class
 *    it retries. So a 20s ceiling produced TWO 20s attempts (~41s total) and the
 *    trace would show a ladder rather than a latency.
 *
 * 45000 is above the ladder's 30s wall-clock bound, so exactly one attempt runs
 * and the recorded duration IS the true request time. It is still a ceiling, so
 * a genuinely wedged connection is still bounded rather than infinite.
 */
const REQUEST_TIMEOUT_MS = 45000

/**
 * Per-path attempt counter, so the trace distinguishes "one slow request" from
 * "a retry ladder spinning". Keyed by path, not full URL, because the refresh
 * endpoint carries a query string.
 */
const attempts = new Map<string, number>()

/**
 * Reset on an in-place re-init (`retryInit`'s fallback path, which does NOT
 * create a fresh JS context). Without it the counter keeps climbing across
 * attempts and the second launch's very first request is labelled "attempt 3",
 * which reads as a retry ladder that never happened — the exact misreading
 * this instrumentation exists to prevent.
 */
export const resetAttemptCounters = () => attempts.clear()

export const timeoutFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url

  if (!shouldTimeout(url)) return fetch(input, init)

  // Path only: the token endpoint carries `?grant_type=refresh_token`, and the
  // profile query carries its filters, both of which would make every attempt
  // look like a different request and hide a ladder.
  const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')
  const n = (attempts.get(path) ?? 0) + 1
  attempts.set(path, n)
  const span = `net ${path}${n > 1 ? ` (attempt ${n})` : ''}`
  bootTrace.spanStart(span)

  const controller = new AbortController()
  const timer = setTimeout(() => {
    // Aborting produces a rejection, which every caller above already handles.
    // The whole point is to convert "hangs forever" into "fails", because the
    // codebase has handling for failure and no handling at all for silence.
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  // Respect a caller-supplied signal rather than discarding it: dropping it
  // would silently break any future cancellation the app does itself.
  const upstream = init?.signal
  if (upstream) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener('abort', () => controller.abort())
  }

  return fetch(input, { ...init, signal: controller.signal })
    .then((res) => {
      // Status is recorded because a fast 401 and a fast 200 are very different
      // launches: the first means the refresh token is dead and the spinner was
      // never a latency problem at all.
      bootTrace.spanEnd(span, `HTTP ${res.status}`)
      return res
    })
    .catch((err) => {
      bootTrace.spanEnd(
        span,
        controller.signal.aborted
          ? `ABORTED at ceiling (${REQUEST_TIMEOUT_MS}ms)`
          : `failed: ${String((err as Error)?.message ?? err).slice(0, 80)}`,
      )
      throw err
    })
    .finally(() => {
      clearTimeout(timer)
    })
}
