// The single entry point for "this ride is not going to be captured."
//
// Before this existed, four separate callers cancelled rides with a bare
// `.update({ status: 'cancelled' })` and none of them touched Stripe:
//   • ScheduledRidesScreen.tsx      (passenger, scheduled)
//   • PassengerHomeScreen.tsx       (passenger, active)
//   • DashboardPage.tsx             (dispatch)
//   • expire-pending-rides          (system: 'timeout' + 'missed_window')
// The only thing that ever released a hold was Stripe's own ~7-day
// authorization expiry. A ride the system itself killed for 'missed_window'
// left the passenger's money held for a week.
//
// It also closes a gap there was no path for at all: a driver could not
// cancel or file a no-show from ANY status. Combined with no cron reaping
// 'assigned'/'driver_arriving'/'in_progress', one passenger no-show left a
// ride terminal-stuck AND kept the driver in every busy-set filter
// (assign-ride:213, scheduled-release:153/423) indefinitely — one no-show
// removed a car from the fleet until a human noticed.
//
// Actions:
//   cancel          passenger / dispatch / system — ends the ride, releases the hold
//   no_show         driver only, geo+time gated — ends the ride, releases the hold
//   driver_release  driver only — hands the ride BACK to dispatch, hold untouched
//   cash_fallback   hold goes away, ride does not — the ride becomes cash
//   release_hold    system only — release a hold left behind on an already-
//                   cancelled ride (the backstop sweep); touches nothing else
//
// Ordering is load-bearing: the hold is released BEFORE the row is written,
// so a Stripe failure can never leave a cancelled ride with a live hold.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendPush as sendPushShared } from '../_shared/push.ts'

const STRIPE_SECRET_KEY  = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API         = 'https://api.stripe.com/v1'
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
const ASSIGN_RIDE_URL    = `${SUPABASE_URL}/functions/v1/assign-ride`

// No-show gate. Ungated, "passenger didn't show" is a free cherry-pick
// button — the driver could dump a fare they disliked from three blocks
// away. Both conditions must hold.
const NO_SHOW_MIN_WAIT_MINS = 5
const NO_SHOW_MAX_DIST_M    = 150

// A released ride due within this window is treated as "now" and goes back to
// the immediate pool; anything further out returns to the scheduled pipeline.
// Matches MIN_LEAD_MINS in scheduled-release, its release floor.
const FUTURE_SCHEDULED_MS = 10 * 60_000
const RELEASABLE_STATUSES = new Set(['assigned', 'offered', 'scheduled'])

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Stripe ────────────────────────────────────────────────────
async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  })
  return res.json()
}

async function stripePost(path: string, body: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization:  `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  })
  return res.json()
}

// PI statuses that hold funds without having taken them. Anything in this
// set can be cancelled; 'succeeded' cannot (that is a refund, a different
// flow that lives in vellon-ops).
const CANCELLABLE_PI = new Set([
  'requires_capture',
  'requires_confirmation',
  'requires_action',
  'requires_payment_method',
  'processing',
])

type HoldResult =
  | { ok: true;  released: boolean }
  | { ok: false; error: string; code: 'already_captured' | 'stripe_error' }

// Release the authorization, reading the PI's real status from Stripe rather
// than inferring it from rides.payment_status — same discipline as
// capture-payment, which sizes the capture off the PI and not off the DB.
async function releaseHold(ride: any, reason: string): Promise<HoldResult> {
  if (!ride.stripe_payment_intent_id) return { ok: true, released: false }

  const intent = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
  if (intent.error) {
    console.error(`[settle-ride ${ride.id}] PI fetch failed:`, JSON.stringify(intent.error))
    return { ok: false, error: intent.error.message, code: 'stripe_error' }
  }

  if (intent.status === 'canceled') return { ok: true, released: false } // idempotent
  if (intent.status === 'succeeded') {
    // Money already moved. Cancelling here would silently strand a captured
    // charge; the caller needs to know so it can route to a refund instead.
    return { ok: false, error: 'Payment already captured — this is a refund, not a cancellation', code: 'already_captured' }
  }
  if (!CANCELLABLE_PI.has(intent.status)) {
    console.warn(`[settle-ride ${ride.id}] unexpected PI status '${intent.status}' — leaving alone`)
    return { ok: true, released: false }
  }

  const cancellationReason =
    reason === 'timeout' || reason === 'missed_window' || reason === 'stuck'
      ? 'abandoned'
      : 'requested_by_customer'

  const cancelled = await stripePost(
    `/payment_intents/${ride.stripe_payment_intent_id}/cancel`,
    { cancellation_reason: cancellationReason },
    // Reason is part of the key: an identical retry still dedupes (the point of
    // the key), but two cancels of the same ride for different reasons can't
    // collide as "same key, different parameters" at Stripe.
    `settle-${ride.id}-${cancellationReason}`,
  )

  if (cancelled.error) {
    // Lost a race with a concurrent capture/cancel — re-read the truth.
    const recheck = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
    if (recheck.status === 'canceled') return { ok: true, released: true }
    if (recheck.status === 'succeeded') {
      return { ok: false, error: 'Payment already captured', code: 'already_captured' }
    }
    console.error(`[settle-ride ${ride.id}] PI cancel failed:`, JSON.stringify(cancelled.error))
    return { ok: false, error: cancelled.error.message, code: 'stripe_error' }
  }

  console.log(`[settle-ride ${ride.id}] hold released (${cancellationReason})`)
  return { ok: true, released: true }
}

// ── Push ──────────────────────────────────────────────────────
async function sendPush(userId: string | null, title: string, body: string, data: object = {}) {
  if (!userId) return
  const { data: profile } = await supabase
    .from('profiles').select('push_token').eq('id', userId).maybeSingle()
  // Ticket parking and dead-token retirement live in _shared/push.ts —
  // see .claude/notes/push-receipts-devicenotregistered.md.
  await sendPushShared(profile?.push_token, title, body, data as Record<string, unknown>)
}

function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ── Who may do what, from which status ────────────────────────
// Asymmetric on purpose. A passenger cancelling is a normal event. A driver
// cancelling is the abuse-prone direction (cherry-picking), so a driver gets
// 'driver_release' — which hands the ride back to dispatch rather than
// killing it — and a gated no-show, never a plain cancel.
const PASSENGER_CANCELLABLE = new Set(['scheduled', 'pending', 'offered', 'assigned', 'driver_arriving'])
const ADMIN_CANCELLABLE     = new Set(['scheduled', 'pending', 'offered', 'assigned', 'driver_arriving', 'in_progress'])
const TERMINAL              = new Set(['completed', 'cancelled'])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const token = authHeader.replace('Bearer ', '')

    const { ride_id, action = 'cancel', reason } = await req.json()
    if (!ride_id) return json({ error: 'ride_id is required' }, 400)

    // System callers (expire-pending-rides and the sweeps) present the
    // service-role key rather than a user JWT.
    const isSystem = token === SERVICE_ROLE_KEY
    let userId: string | null = null
    if (!isSystem) {
      const { data: userData, error: authError } = await supabase.auth.getUser(token)
      if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)
      userId = userData.user.id
    }

    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select(
        'id, status, passenger_id, driver_id, company_id, payment_method, payment_status, ' +
        'stripe_payment_intent_id, scheduled_at, arrived_at, pickup_lat, pickup_lng, ' +
        'preferred_driver_id, claimed_at, ' +
        'declined_by, confirmed_by_driver'
      )
      .eq('id', ride_id)
      .maybeSingle()

    if (rideError || !ride) return json({ error: 'Ride not found' }, 404)

    // ── Resolve the actor ───────────────────────────────────────
    let actor: 'system' | 'passenger' | 'driver' | 'admin'
    if (isSystem) {
      actor = 'system'
    } else if (ride.passenger_id === userId) {
      actor = 'passenger'
    } else if (ride.driver_id === userId) {
      actor = 'driver'
    } else {
      const { data: profile } = await supabase
        .from('profiles').select('role, company_id').eq('id', userId!).maybeSingle()
      if (
        (profile?.role === 'admin' || profile?.role === 'dispatcher') &&
        profile?.company_id === ride.company_id
      ) {
        actor = 'admin'
      } else {
        return json({ error: 'Not your ride' }, 403)
      }
    }

    if (TERMINAL.has(ride.status) && action !== 'release_hold') {
      // Idempotent: a double-tap or a retried sweep should not 500.
      return json({ ok: true, already: ride.status })
    }

    // ── driver_release: hand the ride back, keep the hold ───────
    // Not a cancellation. The passenger keeps their ride; it re-enters the
    // assignment pipeline. Same shape as decline-assigned-ride, which exists
    // because RLS (`WITH CHECK (driver_id = auth.uid())`) means a driver can
    // never null their own driver_id from the client.
    if (action === 'driver_release') {
      if (actor !== 'driver') return json({ error: 'Drivers only' }, 403)
      // 'assigned' is the immediate/started case. A scheduled ride the driver
      // accepted can also sit at 'scheduled' (accepted from the assigned-rides
      // list, which only sets confirmed_by_driver) or 'offered' (accepted
      // straight off a preferred-driver offer) — all three are rides this
      // driver is holding and can hand back.
      if (!RELEASABLE_STATUSES.has(ride.status)) {
        return json({ error: `Cannot release a ride in status '${ride.status}'` }, 409)
      }

      // Where the ride goes back TO depends on whether it is due now.
      // A scheduled ride that was released early to a preferred driver sits at
      // 'assigned' with scheduled_at hours in the future — dropping it to
      // 'pending' would hand it to assign-ride immediately, hours before
      // anyone should be dispatched. It has to go back to 'scheduled' so
      // scheduled-release re-runs its normal dynamic release, exactly as
      // decline-assigned-ride does for the dispatch-assigned case.
      const dueNow =
        !ride.scheduled_at ||
        new Date(ride.scheduled_at).getTime() - Date.now() <= FUTURE_SCHEDULED_MS
      const backTo = dueNow ? 'pending' : 'scheduled'

      // A ride the driver soft-claimed off the Available board carries their own
      // preferred_driver_id. Handing it back has to drop the claim too, or the
      // ride returns to 'scheduled' still reserved for them: scheduled-release
      // would re-offer the ride they just released, and the Available board
      // (which hides any ride with a preferred_driver_id) would never show it to
      // anyone else. A DISPATCH-set preference is left alone — that's dispatch's
      // intent to keep or change, not the driver's.
      const wasOwnClaim = !!ride.claimed_at && ride.preferred_driver_id === userId

      await supabase.rpc('append_declined_by', { p_ride_id: ride.id, p_driver_id: userId })
      const { error: relError } = await supabase
        .from('rides')
        .update({
          driver_id: null,
          confirmed_by_driver: false,
          status: backTo,
          ...(wasOwnClaim
            ? {
                preferred_driver_id:          null,
                claimed_at:                   null,
                claim_checkin_at:             null,
                claim_hold_projected_free_at: null,
              }
            : {}),
        })
        .eq('id', ride.id)
        .eq('driver_id', userId)          // optimistic lock: lost the race, no-op
      if (relError) return json({ error: relError.message }, 500)

      if (dueNow) {
        // Straight back into auto-dispatch rather than waiting for a cron tick.
        await fetch(ASSIGN_RIDE_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
          body:    JSON.stringify({ ride_id: ride.id }),
        })
      }
      // coverage_status is deliberately NOT recomputed here — the ride is back
      // in scheduled-coverage-monitor's normal sweep and it will be corrected
      // within 10 minutes, which beats duplicating the roster/liveness math a
      // third time (broadcast-scheduled-ride and decline-assigned-ride already
      // carry copies of it).

      console.log(`[settle-ride ${ride.id}] released by driver ${userId} → ${backTo}`)
      return json({ ok: true, action: 'driver_release', status: backTo })
    }

    // ── release_hold: strand-cleanup on an already-dead ride ────
    // The backstop for any cancellation that did NOT go through this function
    // (a direct SQL write, an older client build). Releases the authorization
    // and nothing else — the ride is already terminal.
    if (action === 'release_hold') {
      if (actor !== 'system' && actor !== 'admin') return json({ error: 'Not permitted' }, 403)
      const held = await releaseHold(ride, reason ?? 'stranded')
      if (!held.ok) return json({ error: held.error, code: held.code }, held.code === 'already_captured' ? 409 : 502)
      if (held.released || ride.payment_status !== 'unpaid') {
        await supabase.from('rides').update({ payment_status: 'unpaid' }).eq('id', ride.id)
      }
      console.log(`[settle-ride ${ride.id}] stranded hold cleaned up (released=${held.released})`)
      return json({ ok: true, action: 'release_hold', hold_released: held.released })
    }

    // ── cash_fallback: hold goes, ride stays ────────────────────
    // The terminal state of the card-verification ladder. Deliberately NOT
    // dispatch-mediated: the ride just becomes a cash ride and both parties
    // are told. Cash and card are invoiced at the same rate, so nothing about
    // the platform's cut changes.
    if (action === 'cash_fallback') {
      if (actor !== 'system' && actor !== 'passenger') {
        return json({ error: 'Not permitted' }, 403)
      }
      if (ride.payment_method !== 'card') return json({ ok: true, already: 'cash' })
      const held = await releaseHold(ride, reason ?? 'cash_fallback')
      if (!held.ok) return json({ error: held.error }, held.code === 'already_captured' ? 409 : 502)

      // payment_method is client-immutable by design (guard_ride_payment_method,
      // 20260713) — this runs service-role, which that trigger allows. Flipping
      // it is what makes the fallback real: without it the driver completes a
      // card ride with no PaymentIntent and hits "No payment intent found."
      await supabase.from('rides').update({
        payment_method:       'cash',
        payment_status:       'unpaid',
        payment_check_status: 'cash_fallback',
      }).eq('id', ride.id)

      await sendPush(
        ride.passenger_id,
        'Paying by cash',
        "Your card didn't go through, so this ride is cash — please pay your driver directly.",
        { type: 'cash_fallback', rideId: ride.id },
      )
      await sendPush(
        ride.driver_id,
        'Payment method changed',
        'This ride is now CASH — collect the fare from the passenger.',
        { type: 'cash_fallback', rideId: ride.id },
      )

      console.log(`[settle-ride ${ride.id}] cash fallback applied`)
      return json({ ok: true, action: 'cash_fallback', hold_released: held.released })
    }

    // ── no_show: driver only, geo + time gated ──────────────────
    if (action === 'no_show') {
      if (actor !== 'driver') return json({ error: 'Drivers only' }, 403)
      if (ride.status !== 'driver_arriving') {
        return json({ error: 'You can only report a no-show after arriving at the pickup' }, 409)
      }

      const waitedMins = ride.arrived_at
        ? (Date.now() - new Date(ride.arrived_at).getTime()) / 60_000
        : 0
      if (waitedMins < NO_SHOW_MIN_WAIT_MINS) {
        return json({
          error: `Please wait at least ${NO_SHOW_MIN_WAIT_MINS} minutes at the pickup before reporting a no-show`,
          wait_remaining_mins: Math.ceil(NO_SHOW_MIN_WAIT_MINS - waitedMins),
        }, 409)
      }

      const { data: driver } = await supabase
        .from('drivers').select('current_lat, current_lng').eq('id', userId!).maybeSingle()
      if (driver?.current_lat == null || driver?.current_lng == null) {
        return json({ error: 'Location unavailable — cannot verify you are at the pickup' }, 409)
      }
      const metres = distanceMetres(
        driver.current_lat, driver.current_lng, ride.pickup_lat, ride.pickup_lng,
      )
      if (metres > NO_SHOW_MAX_DIST_M) {
        return json({ error: 'You need to be at the pickup location to report a no-show' }, 409)
      }
    }

    // ── cancel / no_show: release the hold, THEN end the ride ────
    if (action !== 'cancel' && action !== 'no_show') {
      return json({ error: `Unknown action '${action}'` }, 400)
    }

    let cancelledReason: string
    if (action === 'no_show') {
      cancelledReason = 'passenger_no_show'
    } else if (actor === 'passenger') {
      if (!PASSENGER_CANCELLABLE.has(ride.status)) {
        return json({ error: 'This ride is already underway and cannot be cancelled' }, 409)
      }
      cancelledReason = 'passenger_cancelled'
    } else if (actor === 'admin') {
      if (!ADMIN_CANCELLABLE.has(ride.status)) {
        return json({ error: `Cannot cancel a ride in status '${ride.status}'` }, 409)
      }
      cancelledReason = 'dispatch_cancelled'
    } else if (actor === 'driver') {
      // Drivers never plain-cancel — see driver_release above.
      return json({ error: 'Drivers cannot cancel a ride; release it or report a no-show' }, 403)
    } else {
      cancelledReason = reason ?? 'system_cancelled'
    }

    const held = await releaseHold(ride, cancelledReason)
    if (!held.ok) {
      // Do NOT write the cancellation. Leaving the ride live with its hold
      // intact is recoverable; a cancelled ride with a live hold is the exact
      // leak this function exists to close.
      return json({ error: held.error, code: held.code }, held.code === 'already_captured' ? 409 : 502)
    }

    const update: Record<string, unknown> = {
      status:           'cancelled',
      cancelled_reason: cancelledReason,
    }
    if (ride.stripe_payment_intent_id) update.payment_status = 'unpaid'
    if (action === 'no_show')          update.no_show_at     = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('rides').update(update).eq('id', ride.id).not('status', 'eq', 'completed')
    if (updateError) return json({ error: updateError.message }, 500)

    // ── Tell whoever didn't press the button ────────────────────
    if (action === 'no_show') {
      await sendPush(
        ride.passenger_id,
        'Ride cancelled — driver couldn\'t find you',
        'Your driver waited at the pickup but you weren\'t there. You have not been charged.',
        { type: 'no_show', rideId: ride.id },
      )
    } else if (actor === 'passenger') {
      await sendPush(ride.driver_id, 'Ride cancelled', 'The passenger cancelled this ride.', {
        type: 'ride_cancelled', rideId: ride.id,
      })
    } else if (actor === 'admin') {
      await sendPush(ride.passenger_id, 'Ride cancelled', 'Your ride was cancelled by dispatch.', {
        type: 'ride_cancelled', rideId: ride.id,
      })
      await sendPush(ride.driver_id, 'Ride cancelled', 'Dispatch cancelled this ride.', {
        type: 'ride_cancelled', rideId: ride.id,
      })
    }

    console.log(`[settle-ride ${ride.id}] cancelled (${cancelledReason}) by ${actor}, hold_released=${held.released}`)
    return json({ ok: true, action, reason: cancelledReason, hold_released: held.released })
  } catch (err) {
    console.error('[settle-ride] fatal:', err)
    return json({ error: String(err) }, 500)
  }
})
