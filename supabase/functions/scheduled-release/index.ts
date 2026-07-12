// §9 (revised): scheduled-release — dynamic release timing.
// Replaces fixed RELEASE_LEAD_MINS=30 with per-ride drive-time-based threshold.
// Also handles departure reminders (§5.4) for backgrounded drivers.
//
// Cron: */2 * * * * (two entries registered in pg_cron)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL     = 'https://exp.host/--/api/v2/push/send'
const ASSIGN_RIDE_URL   = `${Deno.env.get('SUPABASE_URL')}/functions/v1/assign-ride`
const STRIPE_API        = 'https://api.stripe.com/v1'
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const MAPS_KEY          = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY')!

// §2 constants — global defaults, per-company tuning deferred
const MAX_LEAD_MINS       = 75  // fetch window width AND release ceiling
const MIN_LEAD_MINS       = 10  // release floor
const POOL_SLICE_K        = 3   // Kth-nearest driver for churn slack
const CHURN_BUFFER_MINS   = 8   // runway for decline / no-ack cycles
const ARRIVAL_BUFFER_MINS = 3   // driver arrives slightly before pickup time

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

  // §9.1: Ensure PaymentIntent for card rides before release
  if (ride.payment_method === 'card' && !ride.stripe_payment_intent_id && ride.payment_status !== 'failed') {
    const piOk = await ensurePaymentIntent(ride)
    if (!piOk) {
      console.warn(`[ride ${ride.id}] PI creation failed — proceeding as cash-fallback`)
    }
  }

  // Build available driver pool (same eligibility criteria as assign-ride)
  let driversQuery = supabase
    .from('drivers')
    .select('id, current_lat, current_lng')
    .eq('company_id', ride.company_id)
    .eq('is_active', true)
    .not('current_lat', 'is', null)
    .not('current_lng', 'is', null)

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
  if (!ride.preferred_driver_id) {
    const kthKm = availableDrivers
      .map((d: any) => distanceKm(d.current_lat, d.current_lng, ride.pickup_lat, ride.pickup_lng))
      .sort((a: number, b: number) => a - b)[Math.min(POOL_SLICE_K, availableDrivers.length) - 1]
    const estimatedThreshold = clamp((kthKm / AVG_SPEED_KMH) * 60 + CHURN_BUFFER_MINS, MIN_LEAD_MINS, MAX_LEAD_MINS)

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

  if (ride.preferred_driver_id) {
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
    threshold: clamp(kthMins + CHURN_BUFFER_MINS, MIN_LEAD_MINS, MAX_LEAD_MINS),
    targetDriveMins: kthMins,
  }
}

// ── Dispatch to the right release path ───────────────────────
async function executeRelease(ride: any, targetDriveMins: number | null) {
  if (!ride.preferred_driver_id) {
    await releaseToPool(ride)
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
async function releaseToPreferred(ride: any, viable: boolean, targetDriveMins: number | null) {
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
      assignment_source: 'preferred',
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

// ── Mark at_risk and alert dispatch (once per degradation) ───
async function markAtRiskAndAlert(ride: any, reason: string) {
  const wasAlreadyAtRisk = ride.coverage_status === 'at_risk'

  await supabase.from('rides').update({ coverage_status: 'at_risk' }).eq('id', ride.id)

  if (!wasAlreadyAtRisk && ride.company_id) {
    const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
    })
    const { data: admins } = await supabase.from('profiles')
      .select('push_token')
      .eq('role', 'admin')
      .eq('company_id', ride.company_id)
      .not('push_token', 'is', null)

    for (const admin of admins ?? []) {
      await sendPush(admin.push_token,
        '⚠️ Exclusive ride — preferred driver unavailable',
        `${when} pickup at ${ride.pickup_address} — exclusive driver is offline at release`,
        { rideId: ride.id, type: reason }
      )
    }
    console.log(`[ride ${ride.id}] at_risk alert sent (${reason}) to ${admins?.length ?? 0} admin(s)`)
  }
}

// ── Check if a driver is viable for this ride ─────────────────
async function isDriverViable(driverId: string, ride: any): Promise<boolean> {
  const { data: driver } = await supabase.from('drivers')
    .select('id, is_active, company_id, vehicle_class_id')
    .eq('id', driverId)
    .maybeSingle()

  if (!driver?.is_active) return false
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
async function ensurePaymentIntent(ride: any): Promise<boolean> {
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
    await supabase.from('rides').update({ payment_status: 'failed' }).eq('id', ride.id)
    await sendPush(pax?.push_token,
      '⚠️ Payment method needed',
      'Please add a card or your ride will be paid by cash.',
      { rideId: ride.id }
    )
    return false
  }

  const { data: company } = await supabase.from('companies')
    .select('stripe_account_id').eq('id', ride.company_id).maybeSingle()

  const totalCents = Math.round((ride.fare_estimate ?? 0) * 100)
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
  if (company?.stripe_account_id) {
    piBody['transfer_data[destination]'] = company.stripe_account_id
  }

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
    await supabase.from('rides').update({ payment_status: 'failed' }).eq('id', ride.id)
    await sendPush(pax?.push_token,
      '⚠️ Card payment failed',
      'Your card was declined. Your ride will proceed — please pay cash or update your card.',
      { rideId: ride.id }
    )
    return false
  }

  await supabase.from('rides')
    .update({ stripe_payment_intent_id: intent.id, payment_status: 'pending' })
    .eq('id', ride.id)
  console.log(`[ride ${ride.id}] PI created: ${intent.id}`)
  return true
}

// ── Passenger T-30 / T-15 reminders ─────────────────────────
// Runs across all non-terminal statuses so released rides aren't missed.
// notified_30min / notified_15min flags prevent double-sending.
// Wide threshold (<=31, <=16) absorbs 2-min cron jitter.
async function sendPassengerReminders(now: Date) {
  const windowEnd = new Date(now.getTime() + 32 * 60_000).toISOString()

  const { data: rides } = await supabase
    .from('rides')
    .select('id, passenger_id, scheduled_at, pickup_address, notified_30min, notified_15min')
    .not('scheduled_at', 'is', null)
    .not('passenger_id', 'is', null)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', windowEnd)
    .not('status', 'in', '("completed","cancelled")')

  if (!rides || rides.length === 0) return

  for (const ride of rides) {
    const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60_000

    const { data: pax } = await supabase.from('profiles')
      .select('name, phone, push_token').eq('id', ride.passenger_id).maybeSingle()

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
      if (pax?.phone) {
        await sendSms(pax.phone,
          `M&G C&J: Your ride at ${when} — your driver will be on the way to ${ride.pickup_address} very soon.`
        )
      }
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
      if (pax?.phone) {
        await sendSms(pax.phone,
          `M&G C&J: Your ride is at ${when}. Be ready at ${ride.pickup_address} — your driver is on the way shortly.`
        )
      }
      await supabase.from('rides').update({ notified_15min: true }).eq('id', ride.id)
      console.log(`[ride ${ride.id}] sent T-15 passenger reminder`)
    }
  }
}

async function sendSms(phone: string, message: string) {
  try {
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ phone, message }),
    })
  } catch (e) { console.error('[sms]', e) }
}

async function sendPush(
  token: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, unknown>
) {
  if (!token) return
  try {
    await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
    })
  } catch (e) { console.error('[push]', e) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
