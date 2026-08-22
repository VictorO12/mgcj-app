// G3 Phase 2 — opens and closes the masked phone line for a ride.
//
// Design: .claude/notes/G3-phase2-masked-telephony-plan.md §3, §4
//
// ── Why this is a Database Webhook and not a call from the assign paths ─────
// A driver gets attached to a ride in at least four places: assign-ride (incl.
// its two-pass decline/timeout cycling), dispatch-assign-ride, scheduled-
// release's preferred-driver branch, and a soft claim re-confirmed at release.
// Allocating from each of them is four places to forget, and the one that
// forgets produces a HIDDEN CALL BUTTON -- which nobody reports as a bug,
// because a missing button looks like a feature that hasn't shipped yet. The
// row transition is the single truth, so this hangs off the row.
//
// Same pattern as notify-passenger and send-ride-receipt: rides UPDATE ->
// webhook -> here, authenticated by WEBHOOK_SECRET.
//
// ── The window opens and closes with the chat window, deliberately ──────────
// Allocation happens on the same statuses ride_accepts_messages() calls live,
// and expiry is completed_at + ride_contact_grace() -- the ONE SQL definition
// of D4's two hours, which ride_accepts_messages() now also reads. A phone line
// that outlives the thread is a number still reachable after the product says
// contact is over: a leak with a plausible-looking cause, which is the worst
// kind to find.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  createSession, addParticipant, closeSession, setSessionExpiry,
  proxyConfigured, missingProxyConfig, TwilioProxyError,
} from '../_shared/twilioProxy.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// Exactly the live set in ride_accepts_messages(). 'offered' is NOT here: at
// that point the driver has been rung but has not accepted, the offer expires
// in 60 seconds, and reassign-stale-rides cycles it. Allocating there would
// burn a session per offer and hand a stranger a line to the passenger before
// they had taken the job.
const CONTACTABLE = new Set(['assigned', 'driver_arriving', 'in_progress'])

/** Twilio needs E.164 and will reject anything else. Refusing a malformed
 *  number here is better than opening a session with one leg that can never
 *  connect -- that failure surfaces to a passenger as a call that rings out. */
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+') && digits.length >= 11) return digits
  const bare = digits.replace(/\D/g, '')
  if (bare.length === 10) return `+1${bare}`            // NANP, our whole market
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`
  return null
}

async function liveSession(rideId: string) {
  const { data } = await supabase
    .from('ride_contact_sessions')
    .select('*')
    .eq('ride_id', rideId)
    .is('released_at', null)
    .order('allocated_at', { ascending: false })
    .maybeSingle()
  return data
}

async function release(row: any, reason: string) {
  // Close at Twilio FIRST, then record it. If Twilio fails we deliberately
  // leave released_at NULL and return, so the next transition retries: a row
  // marked released while the line is still live at Twilio is the one state
  // that leaks -- our UI would hide the button while the number kept working
  // for anyone who had already dialled it.
  try {
    await closeSession(row.proxy_session_sid)
  } catch (err) {
    const e = err as TwilioProxyError
    // 404 means Twilio already closed/expired it -- that IS the desired end
    // state, so record it rather than retrying forever.
    if (e.status !== 404) {
      console.error(`[sync-ride-contact] close failed for ${row.proxy_session_sid}:`, e.message, e.code)
      return
    }
  }
  await supabase
    .from('ride_contact_sessions')
    .update({ released_at: new Date().toISOString(), closed_reason: reason })
    .eq('id', row.id)
  console.log(`[sync-ride-contact] released ${row.proxy_session_sid} (${reason})`)
}

async function allocate(ride: any) {
  if (!proxyConfigured()) {
    console.error(`[sync-ride-contact] proxy not configured — missing: ${missingProxyConfig()}`)
    return
  }

  const { data: people } = await supabase
    .from('profiles')
    .select('id, name, phone')
    .in('id', [ride.passenger_id, ride.driver_id].filter(Boolean))

  const passenger = people?.find((p) => p.id === ride.passenger_id)
  const driver    = people?.find((p) => p.id === ride.driver_id)

  const passengerNumber = toE164(passenger?.phone)
  const driverNumber    = toE164(driver?.phone)

  if (!passengerNumber || !driverNumber) {
    // Fail closed and say which leg. A guest passenger booked by dispatch
    // always has a phone (it is their profile key), so this is a data problem
    // worth seeing, not an expected branch.
    console.warn(
      `[sync-ride-contact] ride ${ride.id}: no session — ` +
      `passenger=${passengerNumber ? 'ok' : 'missing/invalid'} ` +
      `driver=${driverNumber ? 'ok' : 'missing/invalid'}`,
    )
    return
  }

  // unique_name must be unique per SESSION and carry no PII (Twilio's rule).
  // A ride can hold several sessions across its life as drivers cycle, so the
  // ride id alone would collide on the second one.
  const uniqueName = `ride-${ride.id}-${Date.now()}`

  let session
  try {
    session = await createSession(uniqueName, { mode: 'voice-and-message' })
  } catch (err) {
    const e = err as TwilioProxyError
    console.error(`[sync-ride-contact] createSession failed:`, e.message, 'code:', e.code)
    return
  }

  let pParticipant, dParticipant
  try {
    // FriendlyName is shown in Twilio's console and must carry no PII per their
    // own guidance, so it names the ROLE, not the person.
    pParticipant = await addParticipant(session.sid, passengerNumber, 'Passenger')
    dParticipant = await addParticipant(session.sid, driverNumber, 'Driver')
  } catch (err) {
    const e = err as TwilioProxyError
    // This is where pool exhaustion lands. FAIL CLOSED (§6.3): tear the
    // half-built session down, write nothing, and let the client find no
    // session and therefore render no button. Never fall back to tel: — a
    // fallback that reveals a real number has failed at the one thing this
    // feature is for. Escalation is to dispatch.
    console.error(
      `[sync-ride-contact] participant add failed (pool exhausted?):`,
      e.message, 'code:', e.code, 'status:', e.status,
    )
    try { await closeSession(session.sid) } catch { /* best effort */ }
    return
  }

  const { error } = await supabase.from('ride_contact_sessions').insert({
    ride_id:                   ride.id,
    driver_id:                 ride.driver_id,
    proxy_session_sid:         session.sid,
    passenger_participant_sid: pParticipant.sid,
    driver_participant_sid:    dParticipant.sid,
    passenger_number:          passengerNumber,
    driver_number:             driverNumber,
    // Each side's own dial-out number. They are usually the same number in a
    // two-party session; we store what the API returned rather than assuming.
    passenger_proxy_number:    pParticipant.proxy_identifier,
    driver_proxy_number:       dParticipant.proxy_identifier,
    mode:                      'voice-and-message',
  })

  if (error) {
    // The row is the only record we have of a live Twilio session. Without it
    // nothing can ever close that session and the line outlives the ride —
    // so if the insert fails, the session must not survive it.
    console.error(`[sync-ride-contact] insert failed, closing orphan session:`, error.message)
    try { await closeSession(session.sid) } catch { /* best effort */ }
    return
  }

  console.log(`[sync-ride-contact] ride ${ride.id}: session ${session.sid} open`)
}

Deno.serve(async (req) => {
  const webhookSecret  = Deno.env.get('WEBHOOK_SECRET')
  const incomingSecret = req.headers.get('x-webhook-secret')
  if (!webhookSecret || incomingSecret !== webhookSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const body = await req.json()
    if (body.type !== 'UPDATE' || body.table !== 'rides') {
      return new Response('Not a ride update', { status: 200 })
    }

    const ride = body.record
    const old  = body.old_record ?? {}

    const driverChanged = ride.driver_id !== old.driver_id
    const statusChanged = ride.status !== old.status
    if (!driverChanged && !statusChanged) {
      return new Response('No relevant change', { status: 200 })
    }

    const existing = await liveSession(ride.id)

    // ── Terminal states ────────────────────────────────────────────────────
    if (ride.status === 'cancelled') {
      // No grace, matching D4 exactly: a cancelled ride has no completed_at and
      // there is nothing to have left in the car.
      if (existing) await release(existing, 'ride_cancelled')
      return new Response('cancelled', { status: 200 })
    }

    if (ride.status === 'completed') {
      // Only on the FIRST completed transition. A completed ride keeps getting
      // written to — the receipt, a review, a flag resolution — and each of
      // those re-enters here with the session still un-released (expiry is
      // Twilio's timer, so released_at stays NULL until it fires). Without this
      // guard that is a Twilio API call per post-completion write. Idempotent,
      // but pointless, and it is rate limit we would only notice at volume.
      if (existing && !existing.expires_at) {
        // Hand the timer to Twilio rather than keeping one ourselves. Note this
        // reads the expiry from SQL — ride_contact_expiry() — instead of adding
        // a third hardcoded "2 hours" beside ride_accepts_messages() and
        // rideAcceptsMessages(). Three copies drift; this one would drift into
        // a phone line outliving its own chat thread.
        const { data: expiry } = await supabase.rpc('ride_contact_expiry', { p_ride_id: ride.id })
        if (expiry) {
          try {
            await setSessionExpiry(existing.proxy_session_sid, new Date(expiry).toISOString())
            await supabase.from('ride_contact_sessions')
              .update({ expires_at: expiry }).eq('id', existing.id)
            console.log(`[sync-ride-contact] ride ${ride.id}: line expires ${expiry}`)
          } catch (err) {
            // If Twilio won't take the expiry we must not leave the line open
            // indefinitely — closing early is the safe direction to fail.
            console.error(`[sync-ride-contact] setExpiry failed, closing now:`, (err as Error).message)
            await release(existing, 'expiry_set_failed')
          }
        } else {
          await release(existing, 'completed_no_expiry')
        }
      }
      return new Response('completed', { status: 200 })
    }

    // ── Driver churn ───────────────────────────────────────────────────────
    // Twilio caps a session at two participants and participants cannot be
    // updated, so a swap means delete-then-create. We close and reopen instead:
    // it sidesteps that restriction rather than living with it, and it leaves
    // one row per (ride, driver) — which is the only shape that can answer
    // "which driver could reach this passenger, and between when and when".
    if (existing && existing.driver_id !== ride.driver_id) {
      await release(existing, ride.driver_id ? 'driver_changed' : 'driver_unassigned')
      if (ride.driver_id && CONTACTABLE.has(ride.status)) await allocate(ride)
      return new Response('driver changed', { status: 200 })
    }

    // ── Open the line ──────────────────────────────────────────────────────
    if (!existing && ride.driver_id && CONTACTABLE.has(ride.status)) {
      await allocate(ride)
      return new Response('allocated', { status: 200 })
    }

    // A ride falling back out of the contactable set without being cancelled —
    // e.g. a driver declining an assignment, which returns it to 'scheduled'.
    if (existing && !CONTACTABLE.has(ride.status)) {
      await release(existing, `left_contactable_${ride.status}`)
      return new Response('released', { status: 200 })
    }

    return new Response('no action', { status: 200 })
  } catch (err) {
    console.error('[sync-ride-contact] error:', err)
    // 200, not 500: a Database Webhook failure has no retry we control, and a
    // non-2xx here just fills the logs. The next ride transition re-evaluates
    // from the row, so a missed tick self-heals rather than stranding.
    return new Response(JSON.stringify({ error: String(err) }), { status: 200 })
  }
})
