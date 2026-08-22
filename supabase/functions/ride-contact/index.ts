// G3 Phase 2 — hands a caller the masked number for their OWN side of a ride.
//
// Design: .claude/notes/G3-phase2-masked-telephony-plan.md §5
//
// ── Why a function, and not RLS on ride_contact_sessions ───────────────────
// Every row of that table holds BOTH parties' real phone numbers, because the
// row is the audit record for a later dispute. RLS GATES ROWS, NOT COLUMNS —
// this codebase has already paid for that lesson once, with the $0.75 ride,
// where a policy admitted the row and the fare column rode along. A
// "participants can read their own session" policy here would hand the driver
// the passenger's real number and vice versa: the exact leak the whole feature
// exists to close, delivered through the front door.
//
// So the table has NO grants to `authenticated` at all. This function is the
// only reader, it runs on the service role, and it returns to each caller
// nothing but a proxy number for their own side. The real numbers never leave
// the database.
//
// ── Fail closed ────────────────────────────────────────────────────────────
// No live session -> { can_contact: false } and the client renders no button.
// There is deliberately no tel:-fallback branch anywhere in this file. A
// fallback that reveals a real number has failed at the one thing the feature
// is for; when the pool is exhausted or telephony is down, the answer is
// "contact dispatch", not "here is their number".
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // Browser callers (the dispatch dashboard, later) preflight this. A 401 on
  // OPTIONS surfaces as an opaque CORS error and fetch rejects before any
  // error handler runs — hence verify_jwt = false in config.toml, with the JWT
  // checked below by getUser(), which is strictly stronger than the gateway's
  // check anyway (the gateway only proves you hold the anon key, and the anon
  // key ships inside the mobile app bundle).
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) return json({ error: 'Not signed in' }, 401)

    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) return json({ error: 'Not signed in' }, 401)
    const userId = userData.user.id

    const { ride_id } = await req.json()
    if (!ride_id) return json({ error: 'ride_id required' }, 400)

    const { data: ride } = await supabase
      .from('rides')
      .select('id, passenger_id, driver_id, status')
      .eq('id', ride_id)
      .maybeSingle()

    if (!ride) return json({ error: 'Ride not found' }, 404)

    // Participation is read live off the rides row, exactly as
    // ride_participant_role() does for chat. That is what makes driver cycling
    // self-revoking: the moment driver_id moves on, the old driver stops being
    // a participant here with no extra bookkeeping. Guest passengers are
    // covered by the same check — authority is the rides row, never company_id,
    // which an anonymous booker does not meaningfully have.
    const role =
      ride.passenger_id === userId ? 'passenger'
      : ride.driver_id === userId  ? 'driver'
      : null

    if (!role) return json({ error: 'Not your ride' }, 403)

    const { data: session } = await supabase
      .from('ride_contact_sessions')
      .select('passenger_proxy_number, driver_proxy_number, expires_at')
      .eq('ride_id', ride_id)
      .is('released_at', null)
      .order('allocated_at', { ascending: false })
      .maybeSingle()

    if (!session) {
      // Not an error. The commonest reason is simply that no driver is on the
      // ride yet. The reason string exists so the client can say something
      // truthful instead of showing a dead button.
      return json({
        can_contact: false,
        reason: ride.driver_id ? 'no_session' : 'no_driver',
      })
    }

    // Live means: we have not released it AND Twilio has not expired it. The
    // second half matters because expiry is Twilio's timer — our row is not
    // rewritten when it fires, so a reader that only checked released_at would
    // keep offering a number that no longer connects.
    if (session.expires_at && new Date(session.expires_at) <= new Date()) {
      return json({ can_contact: false, reason: 'window_closed' })
    }

    // Each side gets ONLY its own dial-out number. Twilio's
    // Participant.proxy_identifier is "the number this participant dials to
    // reach their partner" — so the passenger's number is the passenger's to
    // dial, and it is never the driver's real one.
    const number = role === 'passenger'
      ? session.passenger_proxy_number
      : session.driver_proxy_number

    if (!number) return json({ can_contact: false, reason: 'no_number' })

    return json({
      can_contact: true,
      role,
      // Same number for both actions: the caller dials it to talk and texts it
      // to message, and Twilio routes on (their real number, this number).
      // Two fields rather than one because voice-only / message-only session
      // modes exist and this is the seam where they would differ.
      call_number: number,
      sms_number:  number,
      expires_at:  session.expires_at ?? null,
    })
  } catch (err) {
    console.error('[ride-contact] error:', err)
    return json({ error: String(err) }, 500)
  }
})
