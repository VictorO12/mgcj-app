// §9 (revised): scheduled-release — dynamic release timing.
// Replaces fixed RELEASE_LEAD_MINS=30 with per-ride drive-time-based threshold.
// Also handles departure reminders (§5.4) for backgrounded drivers.
//
// Cron: */2 * * * * (two entries registered in pg_cron)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { computeAuthoritativeFare } from '../_shared/fare.ts'
import { livenessOrFilter, isDriverDispatchable } from '../_shared/presence.ts'
import { sendPush } from '../_shared/push.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const ASSIGN_RIDE_URL   = `${Deno.env.get('SUPABASE_URL')}/functions/v1/assign-ride`
const SETTLE_RIDE_URL   = `${Deno.env.get('SUPABASE_URL')}/functions/v1/settle-ride`
const STRIPE_API        = 'https://api.stripe.com/v1'
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const MAPS_KEY          = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY')!

// §2 constants — global defaults, per-company tuning deferred
const MAX_LEAD_MINS       = 75  // fetch window width AND release ceiling
const MIN_LEAD_MINS       = 10  // release floor
const CARD_RETRY_MINS     = 10  // min spacing between card-verification attempts
const POOL_SLICE_K        = 3   // Kth-nearest driver for churn slack
const CHURN_BUFFER_MINS   = 8   // runway for decline / no-ack cycles
const ARRIVAL_BUFFER_MINS = 3   // driver arrives slightly before pickup time

// §11: soft driver claims (Available board). A claim sets preferred_driver_id
// but NOT driver_id — see migration 20260743_soft_scheduled_claims.sql.
const CLAIM_SLACK_MINS     = 5        // extra release lead for a claimed ride, so a fall-through to the pool still has runway
const CLAIM_CHECKIN_MINS   = 60       // "still good?" ping lead time; only an explicit no acts on the ride
const CLAIM_CHECKIN_FLOOR_MINS = 30   // don't ping if release is already imminent — the offer itself is the better prompt
const CLAIM_HOLD_MARGIN_MINS = 3      // hysteresis on the hold test, so ETA noise can't flip hold/release tick to tick
const CLAIM_HOLD_SLIP_MS   = 60_000   // projected free-time growing by more than this between ticks = falling behind, not converging

// §10: cost controls — bound Distance Matrix usage regardless of company driver count.
// Without these, every 2-min tick DM-queries the *entire* active roster for every
// ride still in its 75-min window, which scales with company size, not with the
// handful of drivers who could realistically take the ride.
const HAVERSINE_POOL_CANDIDATES = 8   // cap DM origins for the pool path (mirrors assign-ride's closest-5 pattern, with slack for Kth-nearest accuracy)
const AVG_SPEED_KMH             = 30  // conservative in-town estimate, used only for the cheap pre-DM gate below
const DM_CALL_MARGIN_MINS       = 15  // only spend a real DM call once the Haversine estimate is within this many minutes of the plausible threshold

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max)
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Batch Distance Matrix call — same pattern as assign-ride's getDriveTimes.
async function getDriveTimes(
  origins: { lat: number; lng: number; id: string }[],
  destLat: number,
  destLng: number
): Promise<Map<string, number>> {
  if (origins.length === 0) return new Map()
  const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|')
  const dest       = `${destLat},${destLng}`
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(originsStr)}` +
    `&destinations=${encodeURIComponent(dest)}` +
    `&key=${MAPS_KEY}` +
    `&mode=driving`
  const res  = await fetch(url)
  const data = await res.json()
  const result = new Map<string, number>()
  if (data.status !== 'OK') {
    console.error('[DM error]', data.status)
    return result
  }
  data.rows.forEach((row: any, i: number) => {
    const el = row.elements[0]
    if (el.status === 'OK') result.set(origins[i].id, el.duration.value) // seconds
  })
  return result
}

Deno.serve(async () => {
  try {
    const now       = new Date()
    const windowEnd = new Date(now.getTime() + MAX_LEAD_MINS * 60_000).toISOString()
    console.log(`[scheduled-release] now=${now.toISOString()} window=${windowEnd}`)

    // §3.1: widen fetch window to MAX_LEAD_MINS so far-fleet rides are visible early
    const { data: rides, error } = await supabase
      .from('rides')
      .select('*')
      .eq('status', 'scheduled')
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', windowEnd)

    if (error) {
      console.error('[scheduled-release] fetch error:', JSON.stringify(error))
      return json({ error: error.message }, 500)
    }

    console.log(`[scheduled-release] ${rides?.length ?? 0} ride(s) in window`)

    for (const ride of rides ?? []) {
      await releaseRide(ride, now)
    }

    // §5.4: push backgrounded drivers when leave_by arrives
    await sendDepartureReminders(now)

    // Passenger T-30 / T-15 reminders — runs across all non-terminal statuses
    // so rides that have already been released still get their reminders
    await sendPassengerReminders(now)

    return json({ ok: true, checked: rides?.length ?? 0 })
  } catch (err) {
    console.error('[scheduled-release] fatal:', err)
    return json({ error: String(err) }, 500)
  }
})

// ── §3.2: Per-ride release decision ──────────────────────────
async function releaseRide(ride: any, now: Date) {
  const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60_000

  // §11.3: pre-release check-in for a soft-claimed ride.
  if (ride.claimed_at) await sendClaimCheckin(ride, minsUntil)

  // §9.1: Ensure PaymentIntent for card rides before release.
  //
  // Gated on payment_check_status, NOT payment_status. The old gate was
  // `payment_status !== 'failed'` — and nothing anywhere ever cleared
  // 'failed', so a single decline permanently disabled PI creation for that
  // ride while the push still told the passenger to "update your card."
  // Updating it could never trigger a retry. payment_status is also already
  // doing double duty as Stripe PI state (stripe-webhook) and capture state
  // (capture-payment); the latch is separate so those can't interfere.
  //
  // Only two latch states stop us trying: a terminal card decline, and a ride
  // that has already been switched to cash.
  //
  // Retries are spaced by CARD_RETRY_MINS. This cron ticks every 2 minutes and
  // the window is 75, so an unthrottled ladder would fire ~37 declined
  // authorizations at one card — enough to look like card testing to Stripe
  // Radar and to earn network penalties for the passenger. The last attempt
  // before the release floor is always allowed, so a ride never falls back to
  // cash without a final try.
  const latch      = ride.payment_check_status
  const lastAt     = ride.payment_check_last_at ? new Date(ride.payment_check_last_at).getTime() : 0
  const sinceMins  = (now.getTime() - lastAt) / 60_000
  const dueForRetry = sinceMins >= CARD_RETRY_MINS
  if (
    ride.payment_method === 'card' &&
    !ride.stripe_payment_intent_id &&
    latch !== 'hard_failed' &&
    latch !== 'cash_fallback' &&
    dueForRetry
  ) {
    const newPiId = await ensurePaymentIntent(ride)
    // ensurePaymentIntent persists the PI id to the row; mirror it onto the
    // in-memory ride too. Without this the cash-fallback test below reads a
    // stale null and switches a ride that just got a valid hold to cash.
    if (newPiId) ride.stripe_payment_intent_id = newPiId
  }

  // Build available driver pool (same eligibility criteria as assign-ride)
  let driversQuery = supabase
    .from('drivers')
    .select('id, current_lat, current_lng')
    .eq('company_id', ride.company_id)
    .eq('is_active', true)
    .not('current_lat', 'is', null)
    .not('current_lng', 'is', null)
    // A driver with no push_token can't be sent an offer — same filter
    // assign-ride applies, so the pool this releases into matches the pool
    // that will actually be dispatched from.
    .not('push_token', 'is', null)
    .or(livenessOrFilter()) // exclude phantoms: online flag set but heartbeat stale

  if (ride.vehicle_class_id) {
    driversQuery = driversQuery.or(`vehicle_class_id.eq.${ride.vehicle_class_id},vehicle_class_id.is.null`)
  }

  const [{ data: allDrivers }, { data: busyRides }] = await Promise.all([
    driversQuery,
    supabase
      .from('rides')
      .select('driver_id')
      .eq('company_id', ride.company_id)
      .in('status', ['assigned', 'driver_arriving', 'in_progress'])
      .not('driver_id', 'is', null),
  ])

  const busySet          = new Set((busyRides ?? []).map((r: any) => r.driver_id))
  const availableDrivers = (allDrivers ?? []).filter((d: any) => !busySet.has(d.id))

  // §3.3: empty pool fallback — bias early
  if (availableDrivers.length === 0) {
    if (minsUntil > MIN_LEAD_MINS) {
      console.log(`[ride ${ride.id}] no drivers — holding (${minsUntil.toFixed(0)} min out)`)
      return
    }
    // Inside MIN_LEAD: force-release so assign-ride can fire the no-drivers alert
    // and dispatch can intervene manually
    console.log(`[ride ${ride.id}] no drivers + inside MIN_LEAD — force-releasing`)
    await executeRelease(ride, null)
    return
  }

  // §10: cheap Haversine-only gate before spending a real DM call.
  // Only applies to the pool path — a preferred-driver DM call is a single
  // origin (1 element), too cheap to bother gating.
  // A soft claim is pool-timed (§11.1): the claimant is non-binding, so the ride
  // should be released when the FLEET says it's time, not when the claimant does.
  // The old preferred-driver timing would hand a claimed ride to the pool up to
  // 75 min early merely because the claimant hadn't started their shift yet.
  if (!ride.preferred_driver_id || ride.claimed_at) {
    const kthKm = availableDrivers
      .map((d: any) => distanceKm(d.current_lat, d.current_lng, ride.pickup_lat, ride.pickup_lng))
      .sort((a: number, b: number) => a - b)[Math.min(POOL_SLICE_K, availableDrivers.length) - 1]
    const estimatedThreshold = clamp(
      (kthKm / AVG_SPEED_KMH) * 60 + CHURN_BUFFER_MINS + (ride.claimed_at ? CLAIM_SLACK_MINS : 0),
      MIN_LEAD_MINS, MAX_LEAD_MINS
    )

    if (minsUntil > estimatedThreshold + DM_CALL_MARGIN_MINS && minsUntil > MIN_LEAD_MINS) {
      console.log(
        `[ride ${ride.id}] Haversine gate: est=${estimatedThreshold.toFixed(1)}min minsUntil=${minsUntil.toFixed(1)} — holding without DM call`
      )
      return
    }
  }

  const { threshold, targetDriveMins } = await computeReleaseThreshold(ride, availableDrivers)
  console.log(
    `[ride ${ride.id}] minsUntil=${minsUntil.toFixed(1)} ` +
    `threshold=${threshold.toFixed(1)} targetDrive=${targetDriveMins?.toFixed(1) ?? 'null'}`
  )

  if (minsUntil <= threshold) {
    await executeRelease(ride, targetDriveMins)
  } else {
    console.log(`[ride ${ride.id}] not yet — holding`)
  }
}

// ── Compute the per-ride release threshold ────────────────────
async function computeReleaseThreshold(
  ride: any,
  availableDrivers: any[]
): Promise<{ threshold: number; targetDriveMins: number | null }> {

  if (ride.preferred_driver_id && !ride.claimed_at) {
    // Time off preferred driver's location regardless of viability.
    // Exclusive + not viable still gets offered to preferred — timing still uses their drive time.
    const { data: prefDriver } = await supabase
      .from('drivers')
      .select('current_lat, current_lng')
      .eq('id', ride.preferred_driver_id)
      .maybeSingle()

    if (prefDriver?.current_lat && prefDriver?.current_lng) {
      const driveTimes = await getDriveTimes(
        [{ lat: prefDriver.current_lat, lng: prefDriver.current_lng, id: ride.preferred_driver_id }],
        ride.pickup_lat, ride.pickup_lng
      )
      if (driveTimes.size === 0) return { threshold: MAX_LEAD_MINS, targetDriveMins: null }
      const driveMins = (driveTimes.get(ride.preferred_driver_id) ?? 0) / 60
      return {
        threshold: clamp(driveMins + CHURN_BUFFER_MINS, MIN_LEAD_MINS, MAX_LEAD_MINS),
        targetDriveMins: driveMins,
      }
    }
    // Preferred driver offline / no location → release early
    return { threshold: MAX_LEAD_MINS, targetDriveMins: null }
  }

  // Pool: Haversine-prefilter to bound DM origins regardless of company driver
  // count (§10), then batch DM those candidates, sort ascending, pick Kth-nearest
  // for churn slack
  const prefiltered = availableDrivers
    .map((d: any) => ({ ...d, straightLineKm: distanceKm(d.current_lat, d.current_lng, ride.pickup_lat, ride.pickup_lng) }))
    .sort((a: any, b: any) => a.straightLineKm - b.straightLineKm)
    .slice(0, HAVERSINE_POOL_CANDIDATES)

  const driveTimes = await getDriveTimes(
    prefiltered.map((d: any) => ({ lat: d.current_lat, lng: d.current_lng, id: d.id })),
    ride.pickup_lat, ride.pickup_lng
  )
  if (driveTimes.size === 0) return { threshold: MAX_LEAD_MINS, targetDriveMins: null }

  const sorted  = [...driveTimes.values()].sort((a, b) => a - b)
  const kthIdx  = Math.min(POOL_SLICE_K, sorted.length) - 1
  const kthMins = sorted[kthIdx] / 60
  return {
    threshold: clamp(
      kthMins + CHURN_BUFFER_MINS + (ride.claimed_at ? CLAIM_SLACK_MINS : 0),
      MIN_LEAD_MINS, MAX_LEAD_MINS
    ),
    targetDriveMins: kthMins,
  }
}

// ── Dispatch to the right release path ───────────────────────
async function executeRelease(ride: any, targetDriveMins: number | null) {
  // Cash fallback: a card ride reaching release with no PaymentIntent has
  // exhausted every card attempt. It lives HERE, not in releaseRide's
  // per-tick body — there it fired on the first decline, up to 75 minutes
  // before pickup, converting the ride to cash instantly and making the
  // retry ladder dead code (observed 2026-08-13: one generic_decline at
  // T-25m flipped the ride straight to cash_fallback). A card is only out of
  // chances at the moment we actually release.
  //
  // The last-chance attempt is here rather than in releaseRide's throttled
  // gate because release happens at `minsUntil <= threshold`, and threshold is
  // per-ride (10–75 min). Keying a guaranteed final try off MIN_LEAD_MINS
  // would never fire for a ride that releases at T-30, leaving the ladder
  // one-shot in practice. Release itself is the real deadline.
  if (
    ride.payment_method === 'card' &&
    !ride.stripe_payment_intent_id &&
    ride.payment_check_status !== 'hard_failed' &&
    ride.payment_check_status !== 'cash_fallback'
  ) {
    const lastChancePi = await ensurePaymentIntent(ride)
    if (lastChancePi) ride.stripe_payment_intent_id = lastChancePi
  }

  // Routed through settle-ride rather than flipped inline so there is exactly
  // one implementation of "release the hold and switch this ride to cash",
  // including the passenger AND driver notifications — the driver has to know
  // to collect before they arrive, not at completion.
  if (ride.payment_method === 'card' && !ride.stripe_payment_intent_id) {
    console.warn(`[ride ${ride.id}] no PaymentIntent at release — switching to cash`)
    try {
      await fetch(SETTLE_RIDE_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({ ride_id: ride.id, action: 'cash_fallback', reason: 'card_unavailable' }),
      })
      ride.payment_method = 'cash'
    } catch (err) {
      console.error(`[ride ${ride.id}] cash fallback failed:`, err)
    }
  }

  if (!ride.preferred_driver_id) {
    await releaseToPool(ride)
    return
  }

  // §11.2: a soft claim is re-confirmed here, and may be held briefly for a
  // claimant who is mid-ride but will clear in time.
  if (ride.claimed_at) {
    await releaseClaimedRide(ride, targetDriveMins)
    return
  }

  const viable = await isDriverViable(ride.preferred_driver_id, ride)

  if (ride.preferred_driver_exclusive) {
    await releaseToPreferred(ride, viable, targetDriveMins)
    if (!viable) await markAtRiskAndAlert(ride, 'exclusive_not_viable_at_release')
  } else {
    if (viable) {
      await releaseToPreferred(ride, true, targetDriveMins)
    } else {
      console.log(`[ride ${ride.id}] soft preferred not viable — falling to pool`)
      await releaseToPool(ride)
    }
  }
}

// ── §5.4: Push backgrounded drivers when leave_by arrives ────
async function sendDepartureReminders(now: Date) {
  const { data: rides } = await supabase
    .from('rides')
    .select('id, driver_id, pickup_address')
    .eq('status', 'assigned')
    .not('scheduled_at', 'is', null)
    .not('leave_by', 'is', null)
    .lte('leave_by', now.toISOString())
    .eq('departure_notified', false)

  if (!rides || rides.length === 0) return
  console.log(`[departure-reminder] ${rides.length} ride(s)`)

  for (const ride of rides) {
    const { data: driver } = await supabase
      .from('drivers').select('push_token').eq('id', ride.driver_id).maybeSingle()

    if (driver?.push_token) {
      await sendPush(
        driver.push_token,
        '🚗 Time to head out',
        `Head to ${ride.pickup_address} now`,
        { rideId: ride.id, type: 'departure_reminder' }
      )
    }

    await supabase.from('rides').update({ departure_notified: true }).eq('id', ride.id)
    console.log(`[ride ${ride.id}] departure reminder sent`)
  }
}

// ── Pool release: flip to pending, invoke assign-ride ────────
// assign-ride stamps leave_by on the winning driver
async function releaseToPool(ride: any) {
  const { data, error } = await supabase
    .from('rides')
    .update({ status: 'pending', offered_at: null })
    .eq('id', ride.id)
    .eq('status', 'scheduled')
    .select('id')

  if (error || !data || data.length === 0) {
    console.log(`[ride ${ride.id}] already released or race condition — skipping`)
    return
  }

  console.log(`[ride ${ride.id}] flipped to pending — invoking assign-ride`)
  const res = await fetch(ASSIGN_RIDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'x-webhook-secret': Deno.env.get('WEBHOOK_SECRET') ?? '',
    },
    body: JSON.stringify({ ride_id: ride.id }),
  })
  const result = await res.json()
  console.log(`[ride ${ride.id}] assign-ride result:`, JSON.stringify(result))
}

// ── Preferred direct-offer: flip to offered, stamp leave_by ──
async function releaseToPreferred(
  ride: any,
  viable: boolean,
  targetDriveMins: number | null,
  source: 'preferred' | 'driver_claim' = 'preferred',
) {
  const now = new Date().toISOString()

  // Conservative 15-min fallback when DM was unavailable
  const effectiveDriveMins = targetDriveMins ?? 15
  const leaveBy = new Date(
    new Date(ride.scheduled_at).getTime() - (effectiveDriveMins + ARRIVAL_BUFFER_MINS) * 60_000
  ).toISOString()

  const { data, error } = await supabase
    .from('rides')
    .update({
      status:            'offered',
      driver_id:         ride.preferred_driver_id,
      offered_at:        now,
      assignment_source: source,
      leave_by:          leaveBy,
      pickup_eta_mins:   Math.round(effectiveDriveMins),
    })
    .eq('id', ride.id)
    .eq('status', 'scheduled')
    .select('id')

  if (error || !data || data.length === 0) {
    console.log(`[ride ${ride.id}] already released — skipping preferred offer`)
    return
  }

  console.log(
    `[ride ${ride.id}] offered to preferred ${ride.preferred_driver_id.slice(0, 8)} ` +
    `(viable=${viable} leave_by=${leaveBy})`
  )

  const { data: prefDriver } = await supabase.from('drivers')
    .select('push_token').eq('id', ride.preferred_driver_id).maybeSingle()

  if (prefDriver?.push_token) {
    const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
    })
    const { data: pax } = await supabase.from('profiles')
      .select('name').eq('id', ride.passenger_id).maybeSingle()
    const passengerName = pax?.name ?? 'A passenger'
    const fareText = ride.fare_estimate ? `$${Number(ride.fare_estimate).toFixed(2)}` : 'Cash'

    await sendPush(prefDriver.push_token,
      '🚗 Your scheduled ride is starting',
      `${passengerName} · ${when} · ${ride.pickup_address} → ${ride.dropoff_address} · ${fareText}`,
      {
        rideId:         ride.id,
        type:           'ride_assigned',
        pickupAddress:  ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareEstimate:   ride.fare_estimate,
        passengerName,
        scheduledAt:    ride.scheduled_at,
      }
    )
  }
}

// ── §11.2: claimed-ride release ───────────────────────────────
// Runs at the pool-computed threshold. Three outcomes:
//   viable      → offer it to the claimant, exactly like a soft preference
//   busy, clears→ HOLD: stay 'scheduled' and re-decide on the next 2-min tick
//   otherwise   → hand it to the pool and tell the claimant it's gone
async function releaseClaimedRide(ride: any, poolDriveMins: number | null) {
  const now       = new Date()
  const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60_000

  const verdict = await evaluateClaimant(ride.preferred_driver_id, ride)

  // Nothing to time — the claim is over. Checked before spending the DM element.
  if (verdict.state === 'unavailable') {
    await dropClaimToPool(ride, 'unavailable')
    return
  }

  // leave_by has to be timed off the CLAIMANT, not the pool's Kth-nearest driver
  // whose position set the release threshold — otherwise the hold deadline below
  // is measured against a stranger's drive time. One DM origin = 1 element.
  const claimantDriveMins = await getClaimantDriveMins(ride) ?? poolDriveMins ?? 15
  const leaveBy = new Date(
    new Date(ride.scheduled_at).getTime() - (claimantDriveMins + ARRIVAL_BUFFER_MINS) * 60_000
  )

  if (verdict.state === 'viable') {
    await releaseToPreferred(ride, true, claimantDriveMins, 'driver_claim')
    return
  }

  if (verdict.state === 'busy' && verdict.freeAt && minsUntil > MIN_LEAD_MINS) {
    // Holding is not free — it blocks the pool release, so every hold spends
    // runway the fallback might need. Two ways out: the projection says they
    // won't clear in time, or it says they keep slipping.
    const clearsInTime =
      verdict.freeAt.getTime() + CLAIM_HOLD_MARGIN_MINS * 60_000 <= leaveBy.getTime()
    const prevProjection = ride.claim_hold_projected_free_at
      ? new Date(ride.claim_hold_projected_free_at).getTime()
      : null
    const slipping =
      prevProjection !== null && verdict.freeAt.getTime() > prevProjection + CLAIM_HOLD_SLIP_MS

    if (clearsInTime && !slipping) {
      await supabase.from('rides')
        .update({ claim_hold_projected_free_at: verdict.freeAt.toISOString() })
        .eq('id', ride.id)
      console.log(
        `[ride ${ride.id}] claimant mid-ride, projected free ${verdict.freeAt.toISOString()} ` +
        `<= leave_by ${leaveBy.toISOString()} — holding`
      )
      return
    }
    console.log(
      `[ride ${ride.id}] claimant hold ended (${slipping ? 'ETA slipping' : 'will not clear in time'})`
    )
  }

  // Only the busy branch reaches here — 'unavailable' returned above.
  await dropClaimToPool(ride, 'busy')
}

// Clear the claim, tell the claimant, then release exactly as if it had never
// been claimed. Order matters: the claim is cleared BEFORE the pool release so
// nothing downstream reads a claim that no longer holds.
async function dropClaimToPool(ride: any, reason: 'busy' | 'unavailable') {
  const claimantId = ride.preferred_driver_id

  await supabase.from('rides')
    .update({
      preferred_driver_id:          null,
      claimed_at:                   null,
      claim_checkin_at:             null,
      claim_hold_projected_free_at: null,
    })
    .eq('id', ride.id)

  // Losing a planned ride silently is the failure mode that kills trust in the
  // board — this push is driver-facing, so the no-admin-push rule doesn't apply.
  const { data: driver } = await supabase.from('drivers')
    .select('push_token').eq('id', claimantId).maybeSingle()
  if (driver?.push_token) {
    const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
    })
    await sendPush(
      driver.push_token,
      'Your planned ride went to the pool',
      reason === 'busy'
        ? `You're still on a trip, so the ${when} pickup at ${ride.pickup_address} was offered to other drivers.`
        : `The ${when} pickup at ${ride.pickup_address} was offered to other drivers.`,
      { rideId: ride.id, type: 'claim_released', reason }
    )
  }

  console.log(`[ride ${ride.id}] claim dropped (${reason}) — releasing to pool`)
  ride.preferred_driver_id = null
  await releaseToPool(ride)
}

// Drive time from the claimant's current position to pickup. Null when they have
// no location (offline) or DM fails — callers fall back to the pool estimate.
async function getClaimantDriveMins(ride: any): Promise<number | null> {
  const { data: d } = await supabase.from('drivers')
    .select('current_lat, current_lng').eq('id', ride.preferred_driver_id).maybeSingle()
  if (!d?.current_lat || !d?.current_lng) return null
  const times = await getDriveTimes(
    [{ lat: d.current_lat, lng: d.current_lng, id: ride.preferred_driver_id }],
    ride.pickup_lat, ride.pickup_lng
  )
  const secs = times.get(ride.preferred_driver_id)
  return secs === undefined ? null : secs / 60
}

type ClaimVerdict =
  | { state: 'viable' }
  | { state: 'busy'; freeAt: Date | null }
  | { state: 'unavailable' }

// Like isDriverViable, but distinguishes "busy right now" from "can't take it at
// all" — a claimed ride is worth holding for the first and not the second.
async function evaluateClaimant(driverId: string, ride: any): Promise<ClaimVerdict> {
  const { data: driver } = await supabase.from('drivers')
    .select('id, is_active, last_seen_at, push_token, company_id, vehicle_class_id, active_ride_eta_seconds')
    .eq('id', driverId)
    .maybeSingle()

  if (!driver || !isDriverDispatchable(driver)) return { state: 'unavailable' }
  if (driver.company_id !== ride.company_id) return { state: 'unavailable' }
  if (ride.vehicle_class_id && driver.vehicle_class_id !== null && driver.vehicle_class_id !== ride.vehicle_class_id) {
    return { state: 'unavailable' }
  }

  const { data: busyRides } = await supabase.from('rides')
    .select('id, status')
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .neq('id', ride.id)

  if (!busyRides || busyRides.length === 0) return { state: 'viable' }

  // Hold ONLY for a trip whose end we can actually bound: status 'in_progress'
  // with a live ETA. drivers.active_ride_eta_seconds is ETA to the CURRENT
  // TARGET, so during 'driver_arriving' it points at a pickup, not a dropoff —
  // reading it as free-time there would undercount by the whole unstarted trip.
  // It is also null whenever DriverActiveRideScreen isn't mounted, so null means
  // unknown, never free. Both cases fall through to freeAt: null = don't hold.
  const soleInProgress =
    busyRides.length === 1 &&
    busyRides[0].status === 'in_progress' &&
    driver.active_ride_eta_seconds != null

  return {
    state:  'busy',
    freeAt: soleInProgress
      ? new Date(Date.now() + driver.active_ride_eta_seconds * 1000)
      : null,
  }
}

// ── §11.3: pre-release check-in ───────────────────────────────
// Asymmetric on purpose: this push carries no accept action and no deadline. A
// "can't make it" tap releases the claim (claim-scheduled-ride, action:release)
// with a full hour of runway instead of the churn buffer; silence does nothing,
// because a claimant mid-ride with the phone in a cradle is still perfectly
// likely to take the ride, and the release-time check already covers them.
async function sendClaimCheckin(ride: any, minsUntil: number) {
  if (ride.claim_checkin_at) return
  // Band, not a ceiling: pinging at T-12 when the offer lands at T-10 is noise.
  if (minsUntil > CLAIM_CHECKIN_MINS || minsUntil < CLAIM_CHECKIN_FLOOR_MINS) return

  const { data: driver } = await supabase.from('drivers')
    .select('push_token').eq('id', ride.preferred_driver_id).maybeSingle()

  if (driver?.push_token) {
    const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
    })
    await sendPush(
      driver.push_token,
      'Still good for your planned ride?',
      `${when} pickup at ${ride.pickup_address}. Tap to release it if you can't make it.`,
      { rideId: ride.id, type: 'claim_checkin' }
    )
  }

  await supabase.from('rides')
    .update({ claim_checkin_at: new Date().toISOString() })
    .eq('id', ride.id)
  console.log(`[ride ${ride.id}] claim check-in sent`)
}

// ── Mark at_risk (dashboard surfaces this via coverage_status) ─
async function markAtRiskAndAlert(ride: any, reason: string) {
  await supabase.from('rides').update({ coverage_status: 'at_risk' }).eq('id', ride.id)
  console.log(`[ride ${ride.id}] marked at_risk (${reason})`)
}

// ── Check if a driver is viable for this ride ─────────────────
async function isDriverViable(driverId: string, ride: any): Promise<boolean> {
  const { data: driver } = await supabase.from('drivers')
    .select('id, is_active, last_seen_at, push_token, company_id, vehicle_class_id')
    .eq('id', driverId)
    .maybeSingle()

  // Dispatchable, not merely live: an offer is a push, so an unreachable
  // driver is not a viable target for one.
  if (!driver || !isDriverDispatchable(driver)) return false
  if (driver.company_id !== ride.company_id) return false
  if (ride.vehicle_class_id && driver.vehicle_class_id !== null && driver.vehicle_class_id !== ride.vehicle_class_id) return false

  const { data: busyRides } = await supabase.from('rides')
    .select('id')
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .neq('id', ride.id)

  return (busyRides ?? []).length === 0
}

// ── §9.1: Create the manual-capture PaymentIntent ─────────────
// Stripe decline codes that no amount of retrying will fix. Everything else
// (insufficient_funds, processing_error, try_again_later, ...) is soft and
// stays retryable by the verification ladder.
const HARD_DECLINE_CODES = new Set([
  'lost_card', 'stolen_card', 'pickup_card', 'expired_card', 'incorrect_number',
  'invalid_account', 'card_not_supported', 'currency_not_supported',
  'restricted_card', 'revocation_of_authorization', 'revocation_of_all_authorizations',
  'stop_payment_order', 'no_card_on_file',
  // 3DS: an off-session retry can never satisfy this — the passenger has to
  // open the app and authenticate. Terminal for the automatic ladder, but it
  // warrants different passenger copy than "your card was declined"; that
  // distinction belongs with the ladder's messaging, not here.
  'authentication_required',
])

function isHardDecline(code: string): boolean {
  return HARD_DECLINE_CODES.has(code)
}

async function ensurePaymentIntent(ride: any): Promise<string | null> {
  const { data: pax } = await supabase.from('profiles')
    .select('stripe_customer_id, push_token').eq('id', ride.passenger_id).maybeSingle()

  let stripePaymentMethodId: string | null = null
  if (ride.payment_method_id) {
    const { data: pm } = await supabase.from('payment_methods')
      .select('stripe_payment_method_id').eq('id', ride.payment_method_id).maybeSingle()
    stripePaymentMethodId = pm?.stripe_payment_method_id ?? null
  }
  if (!stripePaymentMethodId) {
    const { data: pm } = await supabase.from('payment_methods')
      .select('stripe_payment_method_id')
      .eq('passenger_id', ride.passenger_id).eq('is_default', true).maybeSingle()
    stripePaymentMethodId = pm?.stripe_payment_method_id ?? null
  }

  if (!pax?.stripe_customer_id || !stripePaymentMethodId) {
    console.error(`[ride ${ride.id}] no saved card — PI creation skipped`)
    await supabase.from('rides').update({
      payment_status:         'failed',
      payment_check_status:   'hard_failed',
      payment_check_last_at:  new Date().toISOString(),
      payment_check_last_code: 'no_card_on_file',
      payment_check_attempts: (ride.payment_check_attempts ?? 0) + 1,
    }).eq('id', ride.id)
    await sendPush(pax?.push_token,
      '⚠️ Payment method needed',
      'Please add a card or your ride will be paid by cash.',
      { rideId: ride.id }
    )
    return false
  }

  // Recompute the authoritative fare server-side rather than trusting the
  // client-written fare_estimate on the ride row. Resolve the booked discount
  // code (if any) so the RPC can re-validate it at release time — an expired or
  // exhausted code simply yields no code discount now (see the "final fare
  // confirmed near pickup" note in the scheduled-booking UI).
  let discountCode: string | null = null
  if (ride.discount_code_id) {
    const { data: dc } = await supabase.from('discount_codes')
      .select('code').eq('id', ride.discount_code_id).maybeSingle()
    discountCode = dc?.code ?? null
  }

  const fareResult = await computeAuthoritativeFare(supabase, {
    userId:     ride.passenger_id,
    companyId:  ride.company_id,
    pickupLat:  ride.pickup_lat,  pickupLng:  ride.pickup_lng,
    dropoffLat: ride.dropoff_lat, dropoffLng: ride.dropoff_lng,
    discountCode,
    // Read off the row, not a client body: by release time the ride exists and
    // its class is the authoritative one.
    vehicleClassId: ride.vehicle_class_id ?? null,
  })

  // Use the recomputed fare when we got one; only fall back to the stored value
  // on a transient compute failure (Google unreachable → fare 0) so a blip
  // doesn't zero the hold. The freeze trigger keeps that stored value honest.
  const authoritativeFare = fareResult.discountedFare > 0
    ? fareResult.discountedFare
    : (ride.fare_estimate ?? 0)
  const totalCents = Math.round(authoritativeFare * 100)
  const piBody: Record<string, string> = {
    amount:                                       totalCents.toString(),
    currency:                                     'cad',
    customer:                                     pax.stripe_customer_id,
    payment_method:                               stripePaymentMethodId,
    capture_method:                               'manual',
    confirm:                                      'true',
    'automatic_payment_methods[enabled]':         'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    'metadata[passenger_id]':                     ride.passenger_id,
    'metadata[ride_id]':                          ride.id,
  }
  // No transfer_data here for either payout model — see create-payment-intent
  // for why (fixing the company's cut before Stripe's real fee is known let
  // the fee silently eat into Vellon's share). capture-payment handles routing
  // the exact remainder after the real fee is known, for both models.

  const res    = await fetch(`${STRIPE_API}/payment_intents`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(piBody).toString(),
  })
  const intent = await res.json()

  if (intent.error) {
    console.error(`[ride ${ride.id}] PI creation failed:`, JSON.stringify(intent.error))
    // Classify: a soft decline is worth retrying, a hard one never is —
    // retrying a lost/stolen/expired card is pure noise and pushes up the
    // account's decline rate for nothing.
    const code: string = intent.error.decline_code ?? intent.error.code ?? 'unknown'
    await supabase.from('rides').update({
      payment_status:          'failed',
      payment_check_status:    isHardDecline(code) ? 'hard_failed' : 'soft_failed',
      payment_check_last_at:   new Date().toISOString(),
      payment_check_last_code: code,
      payment_check_attempts:  (ride.payment_check_attempts ?? 0) + 1,
    }).eq('id', ride.id)
    await sendPush(pax?.push_token,
      '⚠️ Card payment failed',
      'Your card was declined. Your ride will proceed — please pay cash or update your card.',
      { rideId: ride.id }
    )
    return null
  }

  // Persist the recomputed fare alongside the PI so the app, receipt and
  // capture all agree on the amount the card was actually held for. Skipped on
  // the transient-failure fallback above (nothing new/trustworthy to write).
  const rideUpdate: Record<string, unknown> = {
    stripe_payment_intent_id: intent.id,
    payment_status:           'pending',
    payment_check_status:     'verified',
    payment_check_last_at:    new Date().toISOString(),
    payment_check_last_code:  null,
    payment_check_attempts:   (ride.payment_check_attempts ?? 0) + 1,
  }
  if (fareResult.discountedFare > 0) {
    rideUpdate.fare_estimate     = fareResult.discountedFare
    rideUpdate.pre_discount_fare = fareResult.fare
    rideUpdate.discount_amount   = fareResult.discountAmount
    rideUpdate.discount_type     = fareResult.discountType
    rideUpdate.discount_code_id  = fareResult.discountCodeId
  }
  await supabase.from('rides').update(rideUpdate).eq('id', ride.id)
  console.log(`[ride ${ride.id}] PI created: ${intent.id} — $${authoritativeFare}`)
  return intent.id
}

// ── Passenger T-30 / T-15 reminders ─────────────────────────
// Runs across all non-terminal statuses so released rides aren't missed.
// notified_30min / notified_15min flags prevent double-sending.
// Wide threshold (<=31, <=16) absorbs 2-min cron jitter.
async function sendPassengerReminders(now: Date) {
  const windowEnd = new Date(now.getTime() + 32 * 60_000).toISOString()

  const { data: rides } = await supabase
    .from('rides')
    .select('id, passenger_id, company_id, scheduled_at, pickup_address, notified_30min, notified_15min')
    .not('scheduled_at', 'is', null)
    .not('passenger_id', 'is', null)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', windowEnd)
    .not('status', 'in', '("completed","cancelled")')

  if (!rides || rides.length === 0) return

  // One lookup per company per run, not per ride.
  const companyNames = new Map<string, string | null>()
  async function smsPrefix(companyId: string | null): Promise<string> {
    if (!companyId) return ''
    if (!companyNames.has(companyId)) {
      const { data } = await supabase
        .from('companies').select('name').eq('id', companyId).maybeSingle()
      companyNames.set(companyId, data?.name ?? null)
    }
    const name = companyNames.get(companyId)
    // No name, no prefix. The passenger booked with a taxi company, not with
    // Vellon (the vendor), so there's no sensible fallback to substitute —
    // and any hardcoded carrier name is the bug this replaced.
    return name ? `${name}: ` : ''
  }

  for (const ride of rides) {
    const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60_000

    const { data: pax } = await supabase.from('profiles')
      .select('name, phone, push_token, notification_prefs').eq('id', ride.passenger_id).maybeSingle()

    // Pickup reminders (push + SMS, same category) are opt-out via prefs —
    // unlike ride status changes these aren't safety-critical.
    if (pax?.notification_prefs?.pickup_reminders === false) continue

    const when = new Date(ride.scheduled_at).toLocaleTimeString('en-CA', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
    })

    if (!ride.notified_30min && minsUntil <= 31 && minsUntil > 16) {
      if (pax?.push_token) {
        await sendPush(pax.push_token,
          '⏰ Ride in 30 minutes',
          `Your driver will be on the way to ${ride.pickup_address} soon`,
          { rideId: ride.id, type: 'reminder_30min' }
        )
      }
      // No SMS at T-30. On the SMS-only path we send ONE reminder, not two, and
      // T-15 is the one that changes behaviour ("be ready now" vs "soon").
      await supabase.from('rides').update({ notified_30min: true }).eq('id', ride.id)
      console.log(`[ride ${ride.id}] sent T-30 passenger reminder`)
    }

    if (!ride.notified_15min && minsUntil <= 16 && minsUntil > 0) {
      if (pax?.push_token) {
        await sendPush(pax.push_token,
          '🚗 Driver heading your way soon',
          `Be ready at ${ride.pickup_address} — your ride is at ${when}`,
          { rideId: ride.id, type: 'reminder_15min' }
        )
      }
      // SMS only where push cannot reach — a passenger with a working token has
      // already had the push above, and sending both is pure duplicate spend
      // (real cost is ~$0.015-0.041/segment once carrier fees are added, not the
      // $0.0083 base rate). The population this keeps is the one that matters:
      // dispatch-booked guest passengers, who are keyed by phone number and have
      // no app at all, so in-app push structurally cannot reach them.
      //
      // This gate is only as good as push_token is accurate — a stale token
      // suppresses the SMS *and* the push goes nowhere. That is what the receipt
      // sweep in _shared/pushReceipts.ts exists to guarantee; do not ship this
      // gate without it. Note the recovery is cross-ride, not intra-ride: Expo
      // wants ~15 min before a receipt is readable and the T-30→T-15 gap is
      // exactly 15 minutes, so it's the NEXT ride that falls back correctly.
      if (pax?.phone && !pax?.push_token) {
        await sendSms(pax.phone,
          // Plain hyphen, not an em dash: "—" is outside GSM-7, which forces
          // the whole message to UCS-2 and halves the segment size to 70
          // chars. With "-" the full pickup address still fits one segment,
          // and send-sms normalises any smart punctuation the company name
          // drags in. Roughly 40 chars of prefix are free at a typical
          // address length before this tips into a second segment.
          `${await smsPrefix(ride.company_id)}Your ride is at ${when}. Be ready at ${ride.pickup_address} - your driver is on the way shortly.`
        )
      }
      await supabase.from('rides').update({ notified_15min: true }).eq('id', ride.id)
      console.log(`[ride ${ride.id}] sent T-15 passenger reminder`)
    }
  }
}

async function sendSms(phone: string, message: string) {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ phone, message }),
    })
    // A rejected send (unverified number on the Twilio trial, bad number,
    // no credit) comes back as a 400, which `fetch` resolves happily. The
    // caller marks the reminder sent either way — deliberate, a cron
    // shouldn't retry a reminder forever — but it shouldn't be silent.
    if (!res.ok) {
      console.error(`[sms] send-sms returned ${res.status}:`, await res.text())
    }
  } catch (e) { console.error('[sms]', e) }
}


function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
