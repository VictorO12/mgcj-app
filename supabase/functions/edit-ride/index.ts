// The single entry point for "this ride is still happening, but something about
// it changed" — the time it's due, or where it goes.
//
// Why this can't be a client `.update()`, which is how the time edit shipped:
// `guard_ride_fare_fields` (20260713) freezes fare_estimate against passenger
// writes, and `guard_ride_route_fields` (20260751) now freezes the coordinates
// too. Without both, a passenger could rewrite dropoff_lat/lng to somewhere far
// away while the fare stayed pinned at the old, cheap number — the same class of
// bug as the $0.75 ride. So the fare and the thing the fare is computed FROM
// move together, server-side, or not at all.
//
// Actions:
//   reschedule   change scheduled_at on a scheduled ride nobody is committed to
//   relocate     change pickup and/or dropoff, re-pricing the ride
//
// ── The pricing rule, and the trap it avoids ────────────────────────────────
// Do NOT re-price a moved destination as `pickup → new dropoff`. That is the
// obvious implementation and it is a free-ride exploit: a passenger who rides
// twenty minutes out and then changes the destination to somewhere back near
// the pickup gets a near-minimum fare, and the driver eats the whole trip.
//
// Once a driver is carrying the passenger, the fare is:
//
//   base + (driven-so-far + still-to-drive) × rate_per_km
//
// which is one Directions call with the driver's live position as a waypoint
// (see routeMetres in _shared/fare.ts). It is monotonic — the fare can never
// fall below the distance already covered — which is the property that makes it
// defensible to the driver.
//
// ── The Stripe ordering, which is the INVERSE of settle-ride's ──────────────
// settle-ride releases the hold BEFORE writing the row, so a Stripe failure can
// never leave a cancelled ride holding a passenger's money.
//
// Here the risk runs the other way: the ride is live, and the passenger may be
// sitting in the car. So the new authorization is taken FIRST, the row is only
// written if it succeeds, and the old hold is cancelled last. It is re-taken
// whenever the amount moves in EITHER direction — see the Stripe block for why
// a cheaper ride is the dangerous case, not the safe one. A declined card
// means the edit is refused and the ride continues to its original destination
// with its original hold intact — never a ride driving somewhere with no money
// behind it. Do not "fix" this to match settle-ride.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  routeMetres, routeLegMetres, fareFromMetres, getCompanyPricing,
} from '../_shared/fare.ts'
import { evaluate, COMMITMENT_LOOKAHEAD_MINS, type Commitment } from '../_shared/commitment.ts'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Bounds the Directions spend a single ride can run up. Each relocate is one
// call (~$0.005), which is noise against the ~$0.42/ride Maps model — but a
// passenger tapping around on the destination picker is not, and there is no
// legitimate flow that needs a fourth change.
const MAX_EDITS = 3

// Pickup can only move while nobody has been sent to it. Once a driver is
// assigned, moving the pickup invalidates the assignment itself — the ETA, the
// leave_by, and quite possibly which driver was closest — so that stays a
// cancel-and-rebook, or a dispatch action from the dashboard.
const PICKUP_EDITABLE  = new Set(['scheduled', 'pending'])
const DROPOFF_EDITABLE = new Set(['scheduled', 'pending', 'offered', 'assigned', 'driver_arriving', 'in_progress'])

// Statuses where a driver is committed to this ride: the fare is effectively
// final, the passenger is mid-commitment, and the commitment guard applies.
const DRIVER_COMMITTED = new Set(['offered', 'assigned', 'driver_arriving', 'in_progress'])

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

function declineMessage(code?: string): string {
  switch (code) {
    case 'insufficient_funds': return 'Your card was declined for insufficient funds, so the new destination could not be authorized.'
    case 'expired_card':       return 'Your card has expired, so the new destination could not be authorized.'
    default:                   return 'Your card was declined, so the new destination could not be authorized.'
  }
}

// ── Push ──────────────────────────────────────────────────────
async function sendPush(userId: string | null, title: string, body: string, data: object = {}) {
  if (!userId) return
  const { data: profile } = await supabase
    .from('profiles').select('push_token').eq('id', userId).maybeSingle()
  if (!profile?.push_token) return
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: profile.push_token, sound: 'default', title, body, data }),
    })
  } catch (err) {
    console.error('[edit-ride] push failed:', err)
  }
}

/**
 * Will extending this trip to a new dropoff make the driver late for a
 * scheduled pickup they have already confirmed?
 *
 * Same question assign-ride asks before offering a ride, through the same
 * `evaluate()` — a destination change is that hazard arriving by a different
 * door, and it was the one case the commitment guard did not cover. The driver
 * is already with the passenger, so the drive-to-pickup leg is zero and the
 * clock starts now.
 */
async function commitmentConflict(
  ride: any, driverId: string, tripMins: number, dropoffLat: number, dropoffLng: number,
) {
  const horizonISO = new Date(Date.now() + COMMITMENT_LOOKAHEAD_MINS * 60_000).toISOString()
  const { data: rows } = await supabase
    .from('rides')
    .select('id, scheduled_at, pickup_lat, pickup_lng')
    .eq('driver_id', driverId)
    .eq('confirmed_by_driver', true)
    .in('status', ['scheduled', 'pending', 'offered', 'assigned'])
    .not('scheduled_at', 'is', null)
    .neq('id', ride.id)
    .gte('scheduled_at', new Date().toISOString())
    .lte('scheduled_at', horizonISO)
    .order('scheduled_at', { ascending: true })
    .limit(1)

  const row = rows?.[0]
  if (!row || row.pickup_lat == null || row.pickup_lng == null) return null

  const commitment: Commitment = {
    ride_id:      row.id,
    scheduled_at: row.scheduled_at,
    pickup_lat:   row.pickup_lat,
    pickup_lng:   row.pickup_lng,
  }
  // driveToPickupMins = 0: the passenger is already aboard.
  const verdict = evaluate(commitment, Date.now(), 0, tripMins, dropoffLat, dropoffLng)
  return verdict.misses ? { commitment, verdict } : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const token = authHeader.replace('Bearer ', '')

    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)
    const userId = userData.user.id

    const body = await req.json()
    const { ride_id, action } = body
    if (!ride_id) return json({ error: 'ride_id is required' }, 400)
    if (action !== 'reschedule' && action !== 'relocate') {
      return json({ error: "action must be 'reschedule' or 'relocate'" }, 400)
    }

    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select(
        'id, status, passenger_id, driver_id, company_id, payment_method, scheduled_at, ' +
        'pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address, ' +
        'fare_estimate, pre_discount_fare, discount_amount, discount_type, discount_code_id, ' +
        'stripe_payment_intent_id, preferred_driver_id, claimed_at, edit_count'
      )
      .eq('id', ride_id)
      .maybeSingle()
    if (rideError || !ride) return json({ error: 'Ride not found' }, 404)

    // Passenger, or dispatch acting for them. A driver never edits a ride.
    let actor: 'passenger' | 'admin'
    if (ride.passenger_id === userId) {
      actor = 'passenger'
    } else {
      const { data: profile } = await supabase
        .from('profiles').select('role, company_id').eq('id', userId).maybeSingle()
      if (
        (profile?.role === 'admin' || profile?.role === 'dispatcher') &&
        profile?.company_id === ride.company_id
      ) {
        actor = 'admin'
      } else {
        return json({ error: 'Not your ride' }, 403)
      }
    }

    if ((ride.edit_count ?? 0) >= MAX_EDITS) {
      return json({ error: `This ride has already been changed ${MAX_EDITS} times. Please call dispatch.` }, 409)
    }

    // ── reschedule ──────────────────────────────────────────────
    if (action === 'reschedule') {
      const { scheduled_at } = body
      if (!scheduled_at) return json({ error: 'scheduled_at is required' }, 400)
      const whenMs = new Date(scheduled_at).getTime()
      if (!Number.isFinite(whenMs)) return json({ error: 'scheduled_at is not a valid time' }, 400)
      if (whenMs <= Date.now()) return json({ error: 'The new pickup time has to be later than now.' }, 400)

      if (ride.status !== 'scheduled' || ride.driver_id) {
        return json({ error: 'This ride is already under way and cannot be rescheduled.' }, 409)
      }

      // A soft claim is a driver planning their day around THIS time. The
      // claim-fields guard means the passenger's write can't clear it, so
      // without this the ride would keep a claimant who claimed a different
      // time and was never told. Everywhere else in the soft-claim design a
      // driver who loses a ride gets pushed; a moved pickup is no different.
      // A dispatch-set preference (no claimed_at) is dispatch's intent and is
      // left alone.
      const wasClaim = !!ride.claimed_at && !!ride.preferred_driver_id
      const claimantId = wasClaim ? ride.preferred_driver_id : null

      const { data: updated, error: updErr } = await supabase
        .from('rides')
        .update({
          scheduled_at:       new Date(whenMs).toISOString(),
          notified_30min:     false,
          notified_15min:     false,
          departure_notified: false,
          leave_by:           null,
          // Conservative placeholder: scheduled-coverage-monitor recomputes the
          // real value for the new time within 10 minutes.
          coverage_status:    'uncovered',
          edit_count:         (ride.edit_count ?? 0) + 1,
          ...(wasClaim
            ? { preferred_driver_id: null, claimed_at: null, became_open_at: new Date().toISOString() }
            : {}),
        })
        .eq('id', ride.id)
        .eq('status', 'scheduled')
        .is('driver_id', null)
        .select('id')
      if (updErr) return json({ error: updErr.message }, 500)
      // A guard clause matching zero rows is not an error in PostgREST, so
      // without this check a ride that got claimed or released a moment ago
      // would report a successful reschedule that never happened.
      if (!updated?.length) {
        return json({ error: 'A driver just took this ride — please call dispatch to change it.' }, 409)
      }

      if (claimantId) {
        await sendPush(
          claimantId,
          'Scheduled ride changed',
          'A ride you claimed was moved to a new time and is back on the Available board.',
          { type: 'claim_released', ride_id: ride.id },
        )
      }

      // dispatch_events is the DISPATCHER audit log — its dispatcher_id column
      // means what it says. A passenger moving their own ride isn't a dispatch
      // action, and the row's own realtime update is already how the dashboard
      // learns about it, so only log when dispatch did it.
      if (actor === 'admin') {
        await supabase.from('dispatch_events').insert({
          company_id:    ride.company_id,
          dispatcher_id: userId,
          event_type:    'ride.scheduled_modified',
          ride_id:       ride.id,
          details:       { from: ride.scheduled_at, to: new Date(whenMs).toISOString() },
        })
      }

      return json({ ok: true, scheduled_at: new Date(whenMs).toISOString() })
    }

    // ── relocate ────────────────────────────────────────────────
    const { pickup, dropoff } = body
    if (!pickup && !dropoff) return json({ error: 'Nothing to change' }, 400)

    if (pickup && !PICKUP_EDITABLE.has(ride.status)) {
      return json({ error: 'A driver is already on the way — the pickup can no longer be moved.' }, 409)
    }
    if (pickup && ride.driver_id) {
      return json({ error: 'A driver is already on the way — the pickup can no longer be moved.' }, 409)
    }
    if (dropoff && !DROPOFF_EDITABLE.has(ride.status)) {
      return json({ error: 'This ride has finished — the destination can no longer be changed.' }, 409)
    }

    const newPickup  = pickup  ?? { lat: ride.pickup_lat,  lng: ride.pickup_lng,  address: ride.pickup_address }
    const newDropoff = dropoff ?? { lat: ride.dropoff_lat, lng: ride.dropoff_lng, address: ride.dropoff_address }
    for (const p of [newPickup, newDropoff]) {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) {
        return json({ error: 'Missing or invalid coordinates' }, 400)
      }
    }

    const { baseFare, ratePerKm } = await getCompanyPricing(supabase, ride.company_id)
    const inRide = ride.status === 'in_progress'

    let fare: number
    let tripMins = 0
    if (inRide) {
      // Price off where the car actually is, read from the drivers table — not
      // from anything the client sent. The position is the pivot the whole fare
      // turns on, so it gets the same treatment as the fare itself.
      const { data: driver } = await supabase
        .from('drivers')
        .select('current_lat, current_lng')
        .eq('id', ride.driver_id)
        .maybeSingle()
      if (driver?.current_lat == null || driver?.current_lng == null) {
        // Falling back to pickup → new dropoff here is exactly the exploit this
        // function exists to avoid, so refuse instead of guessing.
        return json({ error: "We can't reach the driver's location right now. Please ask them to change the destination." }, 503)
      }

      // One request, two legs: pickup → where the car is now (driven), and
      // there → the new destination (remaining). Reading them separately is
      // what keeps the commitment check below from costing a second call.
      const [driven = 0, remaining = 0] = await routeLegMetres([
        { lat: ride.pickup_lat,        lng: ride.pickup_lng        },
        { lat: driver.current_lat,     lng: driver.current_lng     },
        { lat: Number(newDropoff.lat), lng: Number(newDropoff.lng) },
      ])
      if (!driven && !remaining) {
        return json({ error: 'Could not work out a route to that destination.' }, 400)
      }
      fare = fareFromMetres(driven + remaining, baseFare, ratePerKm)
      tripMins = (remaining / 1000 / 40) * 60   // ~40 km/h urban average
    } else {
      const metres = await routeMetres([
        { lat: Number(newPickup.lat),  lng: Number(newPickup.lng)  },
        { lat: Number(newDropoff.lat), lng: Number(newDropoff.lng) },
      ])
      if (!metres) return json({ error: 'Could not work out a route to that destination.' }, 400)
      fare = fareFromMetres(metres, baseFare, ratePerKm)
      tripMins = (metres / 1000 / 40) * 60
    }

    // ── Discount ────────────────────────────────────────────────
    // Re-resolve it, then floor it at what the passenger already had once a
    // driver is committed. Re-resolving alone would let a code that expired
    // between booking and the edit silently vanish, so the fare would jump for
    // a reason the passenger can't see; the floor keeps a percentage discount
    // scaling correctly with the new fare while making that impossible.
    // Before a driver is committed there is no floor: for a scheduled ride
    // scheduled-release re-prices at release anyway, and pinning a discount
    // here that release would then drop just moves the surprise later.
    // Note this calls compute_discount_for_booking directly rather than going
    // through computeAuthoritativeFare: that helper re-derives the fare from a
    // Directions call of its own, and for a ride under way its two-point
    // pickup → dropoff model is the very number we must not charge. We already
    // hold the authoritative fare; only the discount is still open.
    let code: string | null = null
    if (ride.discount_code_id) {
      const { data: dc } = await supabase
        .from('discount_codes').select('code').eq('id', ride.discount_code_id).maybeSingle()
      code = dc?.code ?? null
    }

    let discountAmount = 0
    let discountType: string | null = null
    let discountCodeId: string | null = null
    if (ride.company_id && fare > 0) {
      const { data: d } = await supabase
        .rpc('compute_discount_for_booking', {
          p_user_id:    ride.passenger_id,
          p_company_id: ride.company_id,
          p_fare:       fare,
          p_code:       code,
        })
        .maybeSingle()
      if (d) {
        discountAmount = d.discount_amount ?? 0
        discountType   = d.discount_type ?? null
        discountCodeId = d.code_id ?? null
      }
    }

    if (DRIVER_COMMITTED.has(ride.status) && Number(ride.discount_amount ?? 0) > discountAmount) {
      discountAmount = Number(ride.discount_amount)
      discountType   = ride.discount_type
      discountCodeId = ride.discount_code_id
    }

    const preDiscountFare = fare
    const discountedFare  = Math.max(0, Math.round((fare - discountAmount) * 100) / 100)

    // ── Commitment guard ────────────────────────────────────────
    if (ride.driver_id && dropoff) {
      const conflict = await commitmentConflict(
        ride, ride.driver_id, tripMins, Number(newDropoff.lat), Number(newDropoff.lng),
      )
      if (conflict) {
        return json({
          error: 'That destination would make your driver late for another booked pickup. Please call dispatch to arrange it.',
          conflict: {
            due_at:        conflict.verdict.due_at,
            minutes_short: conflict.verdict.minutes_short,
          },
        }, 409)
      }
    }

    // ── Stripe ──────────────────────────────────────────────────
    // Only card rides with a live hold need anything here. A scheduled ride
    // before release has no PaymentIntent at all (scheduled-release creates it
    // lazily), which is the cheap and most common case: write and done.
    let newPiId: string | null = null
    let oldPiToCancel: string | null = null

    if (ride.payment_method === 'card' && ride.stripe_payment_intent_id) {
      const intent = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
      if (intent.error) {
        return json({ error: 'Could not reach your payment to update it. Please try again.' }, 502)
      }
      if (intent.status === 'succeeded') {
        return json({ error: 'This ride has already been paid for and can no longer be changed.' }, 409)
      }

      const newCents = Math.round(discountedFare * 100)
      if (newCents !== (intent.amount ?? 0)) {
        // ANY change to the amount, in either direction. capture-payment
        // captures `intent.amount_capturable ?? intent.amount` — the PI's
        // authorized amount, never the row's fare — and then writes that back
        // over fare_final. So an authorization left at the old number is a
        // silent undercharge when the fare went up and a silent OVERCHARGE
        // when it went down: a passenger who shortens their trip would be
        // billed the original amount, with a receipt agreeing with the
        // overcharge. The authorization is the charge, so it has to move with
        // the fare both ways.
        const { data: passenger } = await supabase
          .from('profiles').select('stripe_customer_id').eq('id', ride.passenger_id).maybeSingle()
        const { data: pm } = await supabase
          .from('payment_methods')
          .select('stripe_payment_method_id')
          .eq('passenger_id', ride.passenger_id)
          .eq('is_default', true)
          .maybeSingle()

        if (!passenger?.stripe_customer_id || !pm?.stripe_payment_method_id) {
          return json({ error: 'No card on file to authorize the new fare.' }, 402)
        }

        const created = await stripePost('/payment_intents', {
          amount:                                       newCents.toString(),
          currency:                                     'cad',
          customer:                                     passenger.stripe_customer_id,
          payment_method:                               pm.stripe_payment_method_id,
          capture_method:                               'manual',
          confirm:                                      'true',
          off_session:                                  'true',
          'automatic_payment_methods[enabled]':         'true',
          'automatic_payment_methods[allow_redirects]': 'never',
          'metadata[passenger_id]':                     ride.passenger_id,
          'metadata[ride_id]':                          ride.id,
          'metadata[pre_discount_fare]':                preDiscountFare.toString(),
          'metadata[discount_amount]':                  discountAmount.toString(),
          'metadata[replaces_intent]':                  ride.stripe_payment_intent_id,
        }, `edit-${ride.id}-${(ride.edit_count ?? 0) + 1}`)

        // Insist on a live, capturable hold rather than merely "no error".
        // The idempotency key is derived from edit_count, which does NOT
        // increment when an edit rolls back — so a retry after the rollback
        // path below (which creates a PI, fails, then cancels it) would get
        // that CANCELLED PI back from Stripe's cache with no error set. Testing
        // the status closes that, and every other non-held state, at once.
        if (created.error || created.status !== 'requires_capture') {
          const err = created.error ?? created.last_payment_error ?? {}
          console.error(
            `[edit-ride ${ride.id}] new hold not usable (status=${created.status}):`,
            JSON.stringify(err),
          )
          return json({
            error: declineMessage(err.decline_code ?? err.code),
            decline_code: err.decline_code ?? err.code ?? null,
          }, 402)
        }

        newPiId       = created.id
        oldPiToCancel = ride.stripe_payment_intent_id
      }
    }

    // ── Write ───────────────────────────────────────────────────
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {
      fare_estimate:     discountedFare,
      pre_discount_fare: preDiscountFare,
      discount_amount:   discountAmount,
      discount_type:     discountType,
      discount_code_id:  discountCodeId,
      edit_count:        (ride.edit_count ?? 0) + 1,
    }
    if (pickup) {
      patch.pickup_lat     = Number(newPickup.lat)
      patch.pickup_lng     = Number(newPickup.lng)
      patch.pickup_address = newPickup.address ?? ride.pickup_address
      // The release threshold was computed from the old pickup; let
      // scheduled-release derive a fresh one on its next tick.
      patch.leave_by         = null
      patch.pickup_eta_mins  = null
      patch.coverage_status  = 'uncovered'
    }
    if (dropoff) {
      patch.dropoff_lat        = Number(newDropoff.lat)
      patch.dropoff_lng        = Number(newDropoff.lng)
      patch.dropoff_address    = newDropoff.address ?? ride.dropoff_address
      patch.dropoff_changed_at = now
    }
    if (newPiId) patch.stripe_payment_intent_id = newPiId

    // A soft claim is a driver planning around a specific place as well as a
    // specific time, so a moved PICKUP releases it on the same reasoning as a
    // moved time — see the reschedule branch. A moved destination does not: the
    // claimant is still being asked for the job they claimed.
    const claimantId =
      pickup && ride.claimed_at && ride.preferred_driver_id ? ride.preferred_driver_id : null
    if (claimantId) {
      patch.preferred_driver_id = null
      patch.claimed_at          = null
      patch.became_open_at      = now
    }

    const { data: updated, error: updErr } = await supabase
      .from('rides')
      .update(patch)
      .eq('id', ride.id)
      .eq('status', ride.status)   // optimistic lock: the ride moved on
      .select('id')
    if (updErr || !updated?.length) {
      // The row didn't take. If we minted a hold for it, give it straight back
      // rather than leaving the passenger authorized twice.
      if (newPiId) {
        await stripePost(`/payment_intents/${newPiId}/cancel`, { cancellation_reason: 'abandoned' })
      }
      if (updErr) return json({ error: updErr.message }, 500)
      return json({ error: 'This ride just changed — please try again.' }, 409)
    }

    if (claimantId) {
      await sendPush(
        claimantId,
        'Scheduled ride changed',
        'A ride you claimed now picks up somewhere else and is back on the Available board.',
        { type: 'claim_released', ride_id: ride.id },
      )
    }

    // Old hold last, and only now — the row is written and the new hold is the
    // one of record. See the ordering note in the header.
    if (oldPiToCancel) {
      const cancelled = await stripePost(
        `/payment_intents/${oldPiToCancel}/cancel`,
        { cancellation_reason: 'requested_by_customer' },
        `edit-release-${ride.id}-${oldPiToCancel}`,
      )
      if (cancelled.error) {
        // Not fatal: the ride is correct and funded. The stale hold expires on
        // its own, and sweep-held-transfers is the backstop.
        console.error(`[edit-ride ${ride.id}] stale hold ${oldPiToCancel} not released:`, JSON.stringify(cancelled.error))
      }
    }

    // ── Tell the driver ─────────────────────────────────────────
    if (ride.driver_id && dropoff) {
      await sendPush(
        ride.driver_id,
        'Destination changed',
        `This ride is now going to ${newDropoff.address ?? 'a new destination'}.`,
        { type: 'dropoff_changed', ride_id: ride.id },
      )
    }

    if (actor === 'admin') {
      await supabase.from('dispatch_events').insert({
        company_id:    ride.company_id,
        dispatcher_id: userId,
        event_type:    'ride.route_modified',
        ride_id:       ride.id,
        details: {
          ...(pickup  ? { pickup_from:  ride.pickup_address,  pickup_to:  newPickup.address  } : {}),
          ...(dropoff ? { dropoff_from: ride.dropoff_address, dropoff_to: newDropoff.address } : {}),
          fare_from: ride.fare_estimate,
          fare_to:   discountedFare,
          mid_ride:  inRide,
        },
      })
    }

    return json({
      ok:              true,
      fare_estimate:   discountedFare,
      previous_fare:   ride.fare_estimate,
      discount_amount: discountAmount,
      reauthorized:    !!newPiId,
    })

  } catch (err) {
    console.error('[edit-ride] unexpected:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
