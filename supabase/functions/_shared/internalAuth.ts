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
// Comparing against the service-role key works for both callers with no config
// change: pg_cron jobs already send `Authorization: Bearer <service_role_jwt>`
// in their net.http_post headers, and function-to-function calls already send
// SUPABASE_SERVICE_ROLE_KEY. Rotating the key rotates this gate with it —
// which does mean every cron job's embedded JWT must be updated in the same
// pass as a rotation, exactly as it already must be.

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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
  const header = req.headers.get('Authorization') ?? ''
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  // No key configured means the gate can't be evaluated. Fail CLOSED: an
  // unconfigured secret must not silently become an open door, which is the
  // failure mode this whole file exists to fix.
  if (!SERVICE_ROLE_KEY) {
    console.error('[internalAuth] SUPABASE_SERVICE_ROLE_KEY is unset — refusing all callers')
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!token || !safeEqual(token, SERVICE_ROLE_KEY)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}
