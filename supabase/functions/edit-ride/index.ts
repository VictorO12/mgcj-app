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
// ── Two callers, one money path ─────────────────────────────────────────────
// The passenger app uses `reschedule` and a plain `relocate`. The dispatch
// dashboard uses `relocate` ONLY, folding time, vehicle class and an optional
// manual fare into the same call, because a dispatcher's save is one atomic
// edit and splitting it across two actions would half-apply on a failure.
//
// The dashboard used to write all of this with a direct `.update()` — legal,
// because both freeze triggers exempt `is_staff()`. It re-priced client-side,
// so the fare was not stale, but it never re-authorized Stripe. That is the
// real bug it had: `capture-payment` captures the PaymentIntent's authorized
// amount and writes it back over the fare, so a dispatcher moving a
// destination produced a charge and a receipt that agreed with each other and
// disagreed with the ride. It also skipped the claim release, the notified_* /
// leave_by resets, and the commitment guard.
//
// So the admin extras are additive and actor-gated; a passenger sending any of
// them is refused. `reschedule` is deliberately untouched — it is the shipped,
// live-tested app path.
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
  routeMetres, routeLegMetres, fareFromMetres, getCompanyPricing, getVehicleSurcharge,
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

// Dispatch may move a pickup later than a passenger may: they can phone the
// driver, which is exactly the coordination the passenger-side ban stands in
// for. The one status still excluded is in_progress — the passenger is aboard,
// so the pickup already happened and "moving" it would only corrupt the
// driven-distance leg the mid-ride fare is computed from.
const PICKUP_EDITABLE_ADMIN = new Set(['scheduled', 'pending', 'offered', 'assigned', 'driver_arriving'])

// Moving the time only means something before the pickup happens.
const RESCHEDULABLE_ADMIN = new Set(['scheduled', 'pending', 'offered', 'assigned'])

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
        'stripe_payment_intent_id, preferred_driver_id, claimed_at, edit_count, vehicle_class_id'
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

    // The cap is anti-tap-spam for passengers — and its error message tells them
    // to call dispatch, so applying it to dispatch would close the escape hatch
    // it points at.
    if (actor === 'passenger' && (ride.edit_count ?? 0) >= MAX_EDITS) {
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
    const {
      pickup, dropoff,
      // Admin-only extras. A dispatcher's save is one edit, so they arrive on
      // the same call rather than as a second round trip.
      scheduled_at: newScheduledAtRaw,
      vehicle_class_id: newVehicleClassId,
      fare_override,
      confirm_conflict,
    } = body

    const isAdmin = actor === 'admin'
    if (!isAdmin && (
      newScheduledAtRaw != null || newVehicleClassId !== undefined ||
      fare_override != null || confirm_conflict
    )) {
      // Not merely unsupported — these are the fields that let a caller set
      // their own price and move a booked time past the reschedule branch's
      // guards. The passenger surface stays exactly what shipped.
      return json({ error: 'Not permitted on this ride' }, 403)
    }

    // Resolve the time change first: whether it moved decides several resets
    // below, and an unchanged value sent by a form that always posts every
    // field must not count as a change.
    let newScheduledAtISO: string | null = null
    if (newScheduledAtRaw != null) {
      const whenMs = new Date(newScheduledAtRaw).getTime()
      if (!Number.isFinite(whenMs)) return json({ error: 'scheduled_at is not a valid time' }, 400)
      const iso = new Date(whenMs).toISOString()
      if (!ride.scheduled_at || new Date(ride.scheduled_at).getTime() !== whenMs) {
        if (!ride.scheduled_at) {
          return json({ error: 'This is an immediate ride — it has no scheduled time to move.' }, 409)
        }
        if (!RESCHEDULABLE_ADMIN.has(ride.status)) {
          return json({ error: 'This ride is already under way — its time can no longer be moved.' }, 409)
        }
        if (whenMs <= Date.now()) {
          return json({ error: 'The new pickup time has to be later than now.' }, 400)
        }
        newScheduledAtISO = iso
      }
    }

    // Same treatment for the class: only a real change reprices or is written.
    const classChanged =
      newVehicleClassId !== undefined &&
      (newVehicleClassId || null) !== (ride.vehicle_class_id || null)

    if (!pickup && !dropoff && !newScheduledAtISO && !classChanged && fare_override == null) {
      return json({ error: 'Nothing to change' }, 400)
    }

    const pickupEditable = isAdmin ? PICKUP_EDITABLE_ADMIN : PICKUP_EDITABLE
    if (pickup && !pickupEditable.has(ride.status)) {
      return json({ error: 'A driver is already on the way — the pickup can no longer be moved.' }, 409)
    }
    // A passenger may not move a pickup once anyone is assigned, even if the
    // status has not caught up yet. Dispatch may — they can call the driver.
    if (pickup && ride.driver_id && !isAdmin) {
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

    // Only a change to WHERE the ride goes, what class of car it is, or the
    // dispatcher's own typed number moves the money. A time-only edit does not
    // — and must not: the passenger `reschedule` path leaves the fare alone,
    // and re-pricing here would let a dispatcher nudging a pickup by five
    // minutes trigger a Directions call and a Stripe re-authorization for a
    // fare change nobody asked for (an expired discount, say). Skipping the
    // whole block keeps the two time-change paths behaving identically.
    const needsReprice = !!pickup || !!dropoff || classChanged || fare_override != null

    let preDiscountFare = Number(ride.pre_discount_fare ?? ride.fare_estimate ?? 0)
    let discountedFare  = Number(ride.fare_estimate ?? 0)
    let discountAmount  = Number(ride.discount_amount ?? 0)
    let discountType: string | null   = ride.discount_type ?? null
    let discountCodeId: string | null = ride.discount_code_id ?? null
    let newPiId: string | null        = null
    let oldPiToCancel: string | null  = null
    const inRide = ride.status === 'in_progress'

    if (needsReprice) {
      const { baseFare, ratePerKm } = await getCompanyPricing(supabase, ride.company_id)
      // The class the ride will HAVE after this edit — a dispatcher changing the
      // class is changing the fare, so the surcharge has to come from the new one.
      const effectiveClassId = classChanged ? (newVehicleClassId || null) : (ride.vehicle_class_id ?? null)
      const surchargePercent = await getVehicleSurcharge(supabase, ride.company_id, effectiveClassId)

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
        fare = fareFromMetres(driven + remaining, baseFare, ratePerKm, surchargePercent)
        tripMins = (remaining / 1000 / 40) * 60   // ~40 km/h urban average

        // The two legs are the whole basis of a mid-ride charge and they are
        // stored nowhere — the row keeps only the resulting fare. Without this
        // line the only way to check the pricing after the fact is to invert
        // the formula in SQL and compare against a straight-line estimate.
        console.log(`[edit-ride ${ride.id}] mid-ride re-price: driven=${driven}m ` +
          `remaining=${remaining}m total=${driven + remaining}m ` +
          `base=${baseFare} rate=${ratePerKm} surcharge=${surchargePercent}% -> ${fare}`)
      } else {
        const metres = await routeMetres([
          { lat: Number(newPickup.lat),  lng: Number(newPickup.lng)  },
          { lat: Number(newDropoff.lat), lng: Number(newDropoff.lng) },
        ])
        if (!metres) return json({ error: 'Could not work out a route to that destination.' }, 400)
        fare = fareFromMetres(metres, baseFare, ratePerKm, surchargePercent)
        tripMins = (metres / 1000 / 40) * 60
        console.log(`[edit-ride ${ride.id}] re-price: ${metres}m ` +
          `base=${baseFare} rate=${ratePerKm} surcharge=${surchargePercent}% -> ${fare}`)
      }

      // A dispatcher's typed fare replaces the computed one — they are trusted,
      // and negotiating a price is a real dispatch job the dashboard has always
      // allowed. It is treated as PRE-discount and run through the discount block
      // below like any other fare, because `fare_estimate` is the post-discount
      // number everywhere else in the schema. The dashboard used to write the
      // typed figure straight into `fare_estimate`, which silently erased a
      // passenger's discount every time dispatch touched a discounted ride.
      //
      // Note the route call above still happened: its `tripMins` is what the
      // commitment guard needs, and an override does not make a driver less late.
      if (fare_override != null) {
        const overridden = Number(fare_override)
        if (!Number.isFinite(overridden) || overridden < 0) {
          return json({ error: 'The fare has to be a number.' }, 400)
        }
        fare = Math.round(overridden * 100) / 100
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

      discountAmount = 0
      discountType   = null
      discountCodeId = null
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

      preDiscountFare = fare
      discountedFare  = Math.max(0, Math.round((fare - discountAmount) * 100) / 100)

      // Cash fares round up to the whole dollar, so nobody needs exact change.
      // Both booking paths already do this (PassengerHomeScreen's
      // `Math.ceil(discountedFare)`, and the dashboard's manual booking), and
      // the dispatch fare preview does it too — without it here, every cash
      // edit would come back a few cents off the number dispatch was shown and
      // trigger the "fare recalculated" warning for no real reason.
      if (ride.payment_method === 'cash') {
        discountedFare = Math.ceil(discountedFare)
      }

      // ── Commitment guard ────────────────────────────────────────
      if (ride.driver_id && dropoff) {
        const conflict = await commitmentConflict(
          ride, ride.driver_id, tripMins, Number(newDropoff.lat), Number(newDropoff.lng),
        )
        // For a passenger this is a refusal: the message points them at dispatch,
        // who can actually resolve it by moving the other ride or another driver.
        // For dispatch it is a warning they confirm through — they ARE the escape
        // hatch, and a hard block would leave nobody able to make the call. Same
        // shape as the manual-assignment warning check-ride-conflicts feeds.
        if (conflict && !(isAdmin && confirm_conflict)) {
          return json({
            error: isAdmin
              ? 'That destination would make this driver late for another booked pickup.'
              : 'That destination would make your driver late for another booked pickup. Please call dispatch to arrange it.',
            requires_confirmation: isAdmin,
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

    } // ── end needsReprice ──────────────────────────────────────

    // ── Write ───────────────────────────────────────────────────
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {
      edit_count: (ride.edit_count ?? 0) + 1,
    }
    if (needsReprice) {
      patch.fare_estimate     = discountedFare
      patch.pre_discount_fare = preDiscountFare
      patch.discount_amount   = discountAmount
      patch.discount_type     = discountType
      patch.discount_code_id  = discountCodeId
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
      // Same reasoning as the time change below: a driver accepted a specific
      // place as well as a specific time, and dispatch can now move a pickup on
      // an offered/assigned/driver_arriving ride. Twenty kilometres away is not
      // the job they said yes to, and leaving the confirmation standing would
      // have the commitment guard defend a pickup they never agreed to.
      if (ride.driver_id) patch.confirmed_by_driver = false
    }
    if (dropoff) {
      patch.dropoff_lat        = Number(newDropoff.lat)
      patch.dropoff_lng        = Number(newDropoff.lng)
      patch.dropoff_address    = newDropoff.address ?? ride.dropoff_address
      patch.dropoff_changed_at = now
    }
    if (newPiId) patch.stripe_payment_intent_id = newPiId
    if (classChanged) patch.vehicle_class_id = newVehicleClassId || null

    if (newScheduledAtISO) {
      // Identical resets to the reschedule branch: every one of these is
      // derived from the OLD time and is wrong the moment it moves.
      patch.scheduled_at       = newScheduledAtISO
      patch.notified_30min     = false
      patch.notified_15min     = false
      patch.departure_notified = false
      patch.leave_by           = null
      patch.coverage_status    = 'uncovered'
      // A driver's acceptance was of a specific time. Leaving it standing would
      // let the commitment guard defend a pickup they never agreed to, and let
      // notify-passenger announce a confirmed driver for a time nobody
      // confirmed. They are pushed below and re-accept.
      if (ride.driver_id) patch.confirmed_by_driver = false
    }

    // A soft claim is a driver planning around a specific place as well as a
    // specific time, so a moved PICKUP or a moved TIME releases it — see the
    // reschedule branch. A moved destination does not: the claimant is still
    // being asked for the job they claimed.
    const claimantId =
      (pickup || newScheduledAtISO) && ride.claimed_at && ride.preferred_driver_id
        ? ride.preferred_driver_id
        : null
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

    console.log(`[edit-ride ${ride.id}] applied by ${actor}: ` +
      `fare ${ride.fare_estimate} -> ${needsReprice ? discountedFare : '(unchanged)'}, ` +
      `reauthorized=${!!newPiId}, claim_released=${!!claimantId}`)

    if (claimantId) {
      await sendPush(
        claimantId,
        'Scheduled ride changed',
        pickup
          ? 'A ride you claimed now picks up somewhere else and is back on the Available board.'
          : 'A ride you claimed was moved to a new time and is back on the Available board.',
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
    if (ride.driver_id && newScheduledAtISO) {
      // confirmed_by_driver was just cleared, so this is not a courtesy note —
      // it is the ask to accept the ride again at its new time.
      await sendPush(
        ride.driver_id,
        'Pickup time changed',
        `A ride you accepted was moved to ${new Date(newScheduledAtISO).toLocaleString('en-CA', {
          timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short',
        })}. Please confirm you can still take it.`,
        { type: 'scheduled_time_changed', ride_id: ride.id },
      )
    }
    if (pickup && ride.driver_id) {
      await sendPush(
        ride.driver_id,
        'Pickup moved',
        `This ride now picks up at ${newPickup.address ?? 'a new address'}.`,
        { type: 'pickup_changed', ride_id: ride.id },
      )
    }

    // ── Tell the passenger, when this wasn't their own doing ────
    // A passenger editing their own ride already knows. A DISPATCHER moving
    // the time or the pickup is changing where and when someone has to be
    // standing outside, and notify-passenger won't cover it — that fires on
    // status transitions, and none of this is one.
    if (actor === 'admin' && ride.passenger_id) {
      if (newScheduledAtISO) {
        await sendPush(
          ride.passenger_id,
          'Your pickup time changed',
          `Dispatch moved your ride to ${new Date(newScheduledAtISO).toLocaleString('en-CA', {
            timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short',
          })}.`,
          { type: 'ride_rescheduled', ride_id: ride.id },
        )
      }
      if (pickup) {
        await sendPush(
          ride.passenger_id,
          'Your pickup location changed',
          `Dispatch moved your pickup to ${newPickup.address ?? 'a new address'}.`,
          { type: 'ride_relocated', ride_id: ride.id },
        )
      }
      if (dropoff) {
        await sendPush(
          ride.passenger_id,
          'Your destination changed',
          `Dispatch set your destination to ${newDropoff.address ?? 'a new address'}` +
            (needsReprice ? `. Your fare is now $${discountedFare.toFixed(2)}.` : '.'),
          { type: 'ride_relocated', ride_id: ride.id },
        )
      }
    }

    if (actor === 'admin') {
      await supabase.from('dispatch_events').insert({
        company_id:    ride.company_id,
        dispatcher_id: userId,
        // A time-or-class-only dispatch edit is not a route change, and
        // 'ride.scheduled_modified' is the event the dashboard has always
        // logged for it — keeping it means the audit trail reads the same
        // before and after this moved server-side.
        event_type:    (pickup || dropoff) ? 'ride.route_modified' : 'ride.scheduled_modified',
        ride_id:       ride.id,
        details: {
          ...(pickup  ? { pickup_from:  ride.pickup_address,  pickup_to:  newPickup.address  } : {}),
          ...(dropoff ? { dropoff_from: ride.dropoff_address, dropoff_to: newDropoff.address } : {}),
          ...(newScheduledAtISO ? { scheduled_from: ride.scheduled_at, scheduled_to: newScheduledAtISO } : {}),
          ...(classChanged ? { vehicle_class_id: newVehicleClassId || null } : {}),
          ...(fare_override != null ? { fare_manual: true } : {}),
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
      scheduled_at:    newScheduledAtISO,
    })

  } catch (err) {
    console.error('[edit-ride] unexpected:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
