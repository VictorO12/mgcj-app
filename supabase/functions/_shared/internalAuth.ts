// Request auth for functions that are only ever called by pg_cron or by another
// Edge Function — never by a browser or the mobile app.
//
// Why this exists: `verify_jwt = false` in config.toml disables the gateway's
// JWT check entirely, which makes the function callable by ANYONE on the
// internet who knows the URL. send-sms carried a comment asserting the
// opposite — "Supabase validates this automatically when verify_jwt = false and
// the call comes from another Edge Function using the service role key" — which
// is simply not true, and left an unauthenticated endpoint that sends SMS on
// the project's Twilio account (verified live 2026-08-15: a POST with no
// Authorization header at all reached the function body and returned 400 asking
// for parameters).
//
// Flipping verify_jwt back to true is NOT the fix on its own: the anon key is
// shipped inside the mobile app bundle, so "needs a valid project JWT" means
// "needs a string any user already has on their phone".
//
// INCIDENT 2026-08-15 — why this gate no longer keys off the service-role key
// alone. The original version compared ONLY against SUPABASE_SERVICE_ROLE_KEY,
// on the stated assumption that "pg_cron jobs already send that key". That
// assumption was false in a way that took hours to see:
//
//   - The cron jobs DO send the project's legacy service_role JWT. Verified by
//     fingerprint: every cron.job command's bearer token is byte-identical to
//     the key vellon-ops uses to reach this project, which demonstrably works.
//   - But this project has the NEW Supabase API key system enabled
//     (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS are both present), and
//     the SUPABASE_SERVICE_ROLE_KEY injected into the Edge Function runtime is
//     NOT that legacy JWT.
//
// So the two sides compared unequal strings and every cron-called function
// 401'd from the moment this gate deployed (23:01 UTC): expire-pending-rides,
// scheduled-coverage-monitor, sweep-held-transfers and scheduled-ride-digest
// all silently stopped. Nothing surfaced it — net.http_post records the
// response and moves on, and cron.job_run_details reports SUCCESS because
// enqueuing the request succeeded. Look in net._http_response instead.
//
// Re-stamping the cron jobs could not fix it: there is no single key that
// satisfies both layers, because a non-JWT secret sent as `Authorization:
// Bearer` is rejected by the gateway on any function with verify_jwt = true.
//
// Hence the two paths below. The gate now owns its own secret (INTERNAL_API_KEY)
// rather than borrowing Supabase's key plumbing, so a future key rotation or
// key-format migration cannot take dispatch down again.

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const INTERNAL_API_KEY = Deno.env.get('INTERNAL_API_KEY') ?? ''

// Header for our own key. Deliberately NOT Authorization: that header is read
// by the Supabase gateway before our code runs, and on a function with
// verify_jwt = true (scheduled-ride-digest and sweep-held-transfers have no
// config.toml block, so they default to true) a non-JWT bearer is rejected at
// the gateway. Using a separate header lets a caller satisfy BOTH layers:
// Authorization carries a real project JWT for the gateway, x-internal-key
// carries the secret this gate actually checks.
const INTERNAL_HEADER = 'x-internal-key'

// Length-independent compare. The tokens being compared are long and
// high-entropy, so a timing attack here is close to theoretical — but a
// constant-time compare costs nothing and removes the question.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Returns a 401 Response if the caller is not the service role, or null to
 * proceed. Use as the FIRST statement in Deno.serve:
 *
 *   const denied = requireServiceRole(req)
 *   if (denied) return denied
 */
export function requireServiceRole(req: Request): Response | null {
  // Path 1 — our own secret. Preferred, and the only one that works for a
  // pg_cron caller. See the incident note above.
  if (INTERNAL_API_KEY) {
    const provided = req.headers.get(INTERNAL_HEADER) ?? ''
    if (provided && safeEqual(provided, INTERNAL_API_KEY)) return null
  }

  // Path 2 — the injected service-role key on Authorization. Kept because
  // function-to-function calls (scheduled-release -> send-sms,
  // expire-pending-rides -> capture-payment) send SUPABASE_SERVICE_ROLE_KEY
  // from their own env, so they match this by construction whatever value
  // Supabase injects. Those calls never broke and must keep working.
  if (SERVICE_ROLE_KEY) {
    const header = req.headers.get('Authorization') ?? ''
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token && safeEqual(token, SERVICE_ROLE_KEY)) return null
  }

  // Fail CLOSED. With neither secret configured the gate cannot be evaluated,
  // and an unconfigured secret must not silently become an open door.
  if (!INTERNAL_API_KEY && !SERVICE_ROLE_KEY) {
    console.error('[internalAuth] neither INTERNAL_API_KEY nor SUPABASE_SERVICE_ROLE_KEY is set - refusing all callers')
  }

  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  })
}
