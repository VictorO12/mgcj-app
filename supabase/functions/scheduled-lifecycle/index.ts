import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const MAPS_KEY = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY') ?? ''
const ESCALATION_MINS = 60

Deno.serve(async () => {
  try {
    const now = new Date()
    const windowEnd = new Date(now.getTime() + (ESCALATION_MINS + 5) * 60000).toISOString()
    console.log(`[scheduled-lifecycle] now=${now.toISOString()} windowEnd=${windowEnd}`)

    const { data: rides, error } = await supabase
      .from('rides')
      .select('*')
      .eq('status', 'scheduled')
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', windowEnd)
      .eq('auto_started', false)

    if (error) {
      console.error('[scheduled-lifecycle] fetch error:', JSON.stringify(error))
      return json({ error: error.message }, 500)
    }
    console.log(`[scheduled-lifecycle] ${rides?.length ?? 0} ride(s) in window`)

    for (const ride of rides ?? []) {
      if (ride.driver_id && ride.confirmed_by_driver) await handleClaimed(ride, now)
      else await handleUnclaimed(ride, now)
    }
    return json({ ok: true, processed: rides?.length ?? 0 })
  } catch (err) {
    console.error('[scheduled-lifecycle] fatal:', err)
    return json({ error: String(err) }, 500)
  }
})

// ── Claimed: remind, then auto-start at departure time ─────────
async function handleClaimed(ride: any, now: Date) {
  const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60000

  // Stripe card holds only last ~7 days, so card PaymentIntents for
  // scheduled rides are created here (within the 65-min processing
  // window) rather than at booking time, which can be up to 60 days out.
  if (ride.payment_method === 'card' && !ride.stripe_payment_intent_id && ride.payment_status !== 'failed') {
    await createScheduledPaymentIntent(ride)
  }

  const { data: driver } = await supabase.from('drivers')
    .select('push_token, current_lat, current_lng').eq('id', ride.driver_id).maybeSingle()
  const { data: driverProfile } = await supabase.from('profiles')
    .select('phone').eq('id', ride.driver_id).maybeSingle()
  const { data: pax } = await supabase.from('profiles')
    .select('name, phone, push_token').eq('id', ride.passenger_id).maybeSingle()

  let travelMins = 0
  if (driver?.current_lat && driver?.current_lng) {
    travelMins = (await getDriveMins(driver.current_lat, driver.current_lng, ride.pickup_lat, ride.pickup_lng)) ?? 0
  }

  // Re-validate the claimed driver is still a live commitment, not just a
  // claim made days ago. A claim is intent, not a guarantee — the driver
  // may have gone offline, picked up another fare, or gone home since.
  // This is the same "is the driver viable" question regardless of fleet
  // size, so it's written as a standalone check rather than folded into
  // the 30-min reminder — only the response (reuse the existing
  // re-broadcast/escalation path) is sized for the current single-
  // dispatcher scale.
  if (minsUntil <= 30) {
    const viable = await isDriverViableForRide(ride, driver)
    if (!viable) {
      console.log(`[ride ${ride.id}] claimed driver no longer viable — releasing and re-escalating`)
      await supabase.from('rides')
        .update({ driver_id: null, confirmed_by_driver: false, escalated: true })
        .eq('id', ride.id)
      await reBroadcastAndAlertAdmins(ride, 'driver_dropped')
      return
    }
  }

  if (!ride.notified_30min && minsUntil <= 30 && minsUntil > 15) {
    await sendPush(driver?.push_token, '🗓 Ride in 30 minutes', `Pickup at ${ride.pickup_address}`, { rideId: ride.id })
    await sendPush(pax?.push_token, '⏰ Ride in 30 minutes', `Your driver heads to ${ride.pickup_address} soon`, { rideId: ride.id })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Scheduled pickup in 30 min at ${ride.pickup_address}.`)
    if (pax?.phone) await sendSms(pax.phone, `M&G C&J: Your driver arrives at ${ride.pickup_address} in ~30 min.`)
    await supabase.from('rides').update({ notified_30min: true }).eq('id', ride.id)
  }

  if (!ride.notified_15min && minsUntil <= 15 && minsUntil > 3) {
    await sendPush(driver?.push_token, '🚗 15 minutes — get ready', `Pickup at ${ride.pickup_address}`, { rideId: ride.id })
    await sendPush(pax?.push_token, '🚗 Driver heading out soon', `Be ready at ${ride.pickup_address}`, { rideId: ride.id })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Pickup in 15 min at ${ride.pickup_address}. Head out soon.`)
    if (pax?.phone) await sendSms(pax.phone, `M&G C&J: Your driver arrives at ${ride.pickup_address} in ~15 min.`)
    await supabase.from('rides').update({ notified_15min: true }).eq('id', ride.id)
  }

  // Auto-start: leave now to arrive on time
  if (minsUntil <= Math.max(travelMins, 2)) {
    const { error: upErr } = await supabase.from('rides')
      .update({ status: 'assigned', auto_started: true })
      .eq('id', ride.id).eq('status', 'scheduled')   // guard double-start
    if (upErr) { console.error(`[ride ${ride.id}] auto-start failed:`, JSON.stringify(upErr)); return }

    await sendPush(driver?.push_token, '🚦 Time to go — head to pickup', `Go to ${ride.pickup_address}`, { rideId: ride.id, type: 'auto_start' })
    await sendPush(pax?.push_token, '🚗 Your driver is on the way', `Heading to ${ride.pickup_address}`, { rideId: ride.id })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Your scheduled ride is starting. Head to ${ride.pickup_address} now.`)
    if (pax?.phone) await sendSms(pax.phone, `M&G C&J: Your driver is on the way to ${ride.pickup_address}.`)
    console.log(`[ride ${ride.id}] auto-started`)
  }
}

// ── Unclaimed: flag dispatch + re-broadcast at the 60-min line ──
async function handleUnclaimed(ride: any, now: Date) {
  const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60000
  if (ride.escalated || minsUntil > ESCALATION_MINS || !ride.company_id) return

  await supabase.from('rides').update({ escalated: true }).eq('id', ride.id)
  console.log(`[ride ${ride.id}] escalating — ${minsUntil.toFixed(0)} min out, unclaimed`)
  await reBroadcastAndAlertAdmins(ride, 'unclaimed')
}

// ── Re-offer a ride to company drivers + alert dispatch ─────────
// Shared by the unclaimed-at-60-min path and the claimed-driver-
// went-dark path — both boil down to "this ride needs a new driver,
// surface it to the fleet and to dispatch."
async function reBroadcastAndAlertAdmins(ride: any, reason: 'unclaimed' | 'driver_dropped') {
  if (!ride.company_id) return
  const when = new Date(ride.scheduled_at).toLocaleString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' })

  const { data: drivers } = await supabase.from('drivers')
    .select('push_token').eq('company_id', ride.company_id).eq('is_active', true).not('push_token', 'is', null)
  for (const d of drivers ?? []) {
    await sendPush(d.push_token, '🗓 Scheduled ride still open', `${when} · ${ride.pickup_address} — claim it`,
      { rideId: ride.id, type: 'scheduled_offer', scheduledAt: ride.scheduled_at, pickupAddress: ride.pickup_address, dropoffAddress: ride.dropoff_address, fareEstimate: ride.fare_estimate })
  }

  const { data: admins } = await supabase.from('profiles')
    .select('push_token').eq('role', 'admin').eq('company_id', ride.company_id).not('push_token', 'is', null)
  const adminBody = reason === 'driver_dropped'
    ? `${when} pickup at ${ride.pickup_address} — assigned driver is no longer available`
    : `${when} pickup at ${ride.pickup_address} — no driver yet`
  for (const a of admins ?? []) {
    await sendPush(a.push_token, '⚠️ Scheduled ride needs a driver', adminBody,
      { rideId: ride.id, type: 'dispatch_escalation' })
  }
}

// ── Is the committed driver still a live commitment? ────────────
// A claim made days ago is intent, not a guarantee. This question is
// the same at 2 companies or 200 — only what happens on "no" should
// stay scaled to current size.
async function isDriverViableForRide(ride: any, driver: { current_lat?: number; current_lng?: number } | null) {
  const { data: d } = await supabase.from('drivers')
    .select('is_active').eq('id', ride.driver_id).maybeSingle()
  if (!d?.is_active) return false

  const { data: busyRides } = await supabase.from('rides')
    .select('id').eq('driver_id', ride.driver_id)
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .neq('id', ride.id)
  if ((busyRides ?? []).length > 0) return false

  if (driver?.current_lat && driver?.current_lng) {
    const travelMins = await getDriveMins(driver.current_lat, driver.current_lng, ride.pickup_lat, ride.pickup_lng)
    // null means the Distance Matrix lookup failed (no key, network error,
    // non-OK status) — fail closed rather than treating an unknown ETA as
    // "0 minutes away, always in range".
    if (travelMins === null) return false
    const minsUntil = (new Date(ride.scheduled_at).getTime() - Date.now()) / 60000
    if (travelMins > minsUntil + 20) return false
  }

  return true
}

// ── Create the deferred card PaymentIntent for a scheduled ride ─
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
async function stripePost(path: string, body: Record<string, string> = {}) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  })
  return res.json()
}

async function createScheduledPaymentIntent(ride: any) {
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
      .select('stripe_payment_method_id').eq('passenger_id', ride.passenger_id).eq('is_default', true).maybeSingle()
    stripePaymentMethodId = pm?.stripe_payment_method_id ?? null
  }

  if (!pax?.stripe_customer_id || !stripePaymentMethodId) {
    console.error(`[ride ${ride.id}] no saved card found for deferred PaymentIntent`)
    await supabase.from('rides').update({ payment_status: 'failed' }).eq('id', ride.id)
    await sendPush(pax?.push_token, '⚠️ Payment method needed', 'Please add a card or your ride will need to be paid by cash.', { rideId: ride.id })
    return
  }

  const totalCents = Math.round((ride.fare_estimate ?? 0) * 100)
  const intent = await stripePost('/payment_intents', {
    amount: totalCents.toString(),
    currency: 'cad',
    customer: pax.stripe_customer_id,
    payment_method: stripePaymentMethodId,
    capture_method: 'manual',
    confirm: 'true',
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    'metadata[passenger_id]': ride.passenger_id,
    'metadata[ride_id]': ride.id,
  })

  if (intent.error) {
    console.error(`[ride ${ride.id}] deferred PaymentIntent failed:`, JSON.stringify(intent.error))
    await supabase.from('rides').update({ payment_status: 'failed' }).eq('id', ride.id)
    await sendPush(pax?.push_token, '⚠️ Card payment failed', 'Your saved card was declined. Please update your payment method or pay with cash.', { rideId: ride.id })
    return
  }

  await supabase.from('rides').update({ stripe_payment_intent_id: intent.id }).eq('id', ride.id)
  console.log(`[ride ${ride.id}] deferred PaymentIntent created: ${intent.id}`)
}

// Returns the drive time in minutes, or null if the lookup failed/errored
// (no key, network error, non-OK API/element status) — callers must not
// treat null as "0 minutes away".
async function getDriveMins(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<number | null> {
  if (!MAPS_KEY) { console.error('[drive] no MAPS_KEY configured'); return null }
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${toLat},${toLng}&mode=driving&key=${MAPS_KEY}`
    const j = await (await fetch(url)).json()
    const element = j.rows?.[0]?.elements?.[0]
    if (j.status !== 'OK' || element?.status !== 'OK' || typeof element?.duration?.value !== 'number') {
      console.error('[drive] distance matrix lookup failed:', JSON.stringify({ status: j.status, elementStatus: element?.status }))
      return null
    }
    return Math.ceil(element.duration.value / 60)
  } catch (e) { console.error('[drive]', e); return null }
}
async function sendPush(token: string | null | undefined, title: string, body: string, data: Record<string, unknown>) {
  if (!token) return
  try {
    await fetch(EXPO_PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }) })
  } catch (e) { console.error('[push]', e) }
}
async function sendSms(phone: string, message: string) {
  try {
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ phone, message }) })
  } catch (e) { console.error('[sms]', e) }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}