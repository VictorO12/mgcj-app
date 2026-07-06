// §9: scheduled-release — the release engine. Runs every 2 minutes.
// Picks up status='scheduled' rides within RELEASE_LEAD_MINS of departure
// and injects them into the existing on-demand dispatch path (assign-ride).
// From the moment of release a scheduled ride is indistinguishable from an
// immediate ride — it inherits best-available selection, the 60s offer/ack
// handshake, and pool fallthrough via reassign-stale-rides.
//
// Cron: */2 * * * * (register in Supabase dashboard pg_cron)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL      = 'https://exp.host/--/api/v2/push/send'
const ASSIGN_RIDE_URL    = `${Deno.env.get('SUPABASE_URL')}/functions/v1/assign-ride`
const STRIPE_API         = 'https://api.stripe.com/v1'
const STRIPE_SECRET_KEY  = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const RELEASE_LEAD_MINS  = 30  // configurable per-company later

Deno.serve(async () => {
  try {
    const now      = new Date()
    const windowEnd = new Date(now.getTime() + RELEASE_LEAD_MINS * 60_000).toISOString()
    console.log(`[scheduled-release] now=${now.toISOString()} window=${windowEnd}`)

    // Only rides still in holding — released rides are pending/offered/assigned
    // and don't come back through this query.
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

    console.log(`[scheduled-release] ${rides?.length ?? 0} ride(s) to release`)

    for (const ride of rides ?? []) {
      await releaseRide(ride, now)
    }

    return json({ ok: true, released: rides?.length ?? 0 })
  } catch (err) {
    console.error('[scheduled-release] fatal:', err)
    return json({ error: String(err) }, 500)
  }
})

async function releaseRide(ride: any, now: Date) {
  console.log(`[ride ${ride.id}] releasing — ${ride.preferred_driver_id ? (ride.preferred_driver_exclusive ? 'exclusive' : 'soft preferred') : 'no preferred'}`)

  // ── §9.1: Ensure PaymentIntent for card rides ────────────────
  if (ride.payment_method === 'card' && !ride.stripe_payment_intent_id && ride.payment_status !== 'failed') {
    const piOk = await ensurePaymentIntent(ride)
    if (!piOk) {
      // Payment failed — warn + continue (car still comes, default policy)
      console.warn(`[ride ${ride.id}] PI creation failed — proceeding as cash-fallback`)
    }
  }

  // ── §9.2: Branch on preassignment ───────────────────────────
  if (!ride.preferred_driver_id) {
    await releaseToPool(ride)
    return
  }

  const viable = await isDriverViable(ride.preferred_driver_id, ride)

  if (ride.preferred_driver_exclusive) {
    // Exclusive: always offer to preferred. If not viable, alert dispatch
    // and mark at_risk — but still offer (never auto-substitute a stranger).
    await releaseToPreferred(ride, viable)
    if (!viable) {
      await markAtRiskAndAlert(ride, 'exclusive_not_viable_at_release')
    }
  } else {
    // Soft preferred: offer to preferred if viable, fall to pool otherwise.
    if (viable) {
      await releaseToPreferred(ride, true)
    } else {
      console.log(`[ride ${ride.id}] soft preferred not viable — falling to pool`)
      await releaseToPool(ride)
    }
  }
}

// ── §9.2 no-preferred path ───────────────────────────────────
async function releaseToPool(ride: any) {
  // Optimistic lock — prevents double-release if two ticks overlap
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
    },
    body: JSON.stringify({ ride_id: ride.id }),
  })
  const result = await res.json()
  console.log(`[ride ${ride.id}] assign-ride result:`, JSON.stringify(result))
}

// ── §9.2 preferred (soft viable, or exclusive any-viability) path ───────────
async function releaseToPreferred(ride: any, viable: boolean) {
  const now = new Date().toISOString()

  // Optimistic lock — guard on status='scheduled'
  const { data, error } = await supabase
    .from('rides')
    .update({
      status: 'offered',
      driver_id: ride.preferred_driver_id,
      offered_at: now,
      assignment_source: 'preferred',
    })
    .eq('id', ride.id)
    .eq('status', 'scheduled')
    .select('id')

  if (error || !data || data.length === 0) {
    console.log(`[ride ${ride.id}] already released — skipping preferred offer`)
    return
  }

  console.log(`[ride ${ride.id}] offered to preferred driver ${ride.preferred_driver_id.slice(0, 8)} (viable=${viable})`)

  // Push the offer to the preferred driver
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
        rideId: ride.id,
        type: 'ride_assigned',
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareEstimate: ride.fare_estimate,
        passengerName,
        scheduledAt: ride.scheduled_at,
      }
    )
  }
}

// ── Mark at_risk and alert dispatch (once per degradation) ──────
async function markAtRiskAndAlert(ride: any, reason: string) {
  const wasAlreadyAtRisk = ride.coverage_status === 'at_risk'

  await supabase.from('rides')
    .update({ coverage_status: 'at_risk' })
    .eq('id', ride.id)

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
// Viable = active, same company, right vehicle class, not on a committed ride.
async function isDriverViable(driverId: string, ride: any): Promise<boolean> {
  const { data: driver } = await supabase.from('drivers')
    .select('id, is_active, company_id, vehicle_class_id')
    .eq('id', driverId)
    .maybeSingle()

  if (!driver?.is_active) return false
  if (driver.company_id !== ride.company_id) return false
  if (ride.vehicle_class_id && driver.vehicle_class_id !== ride.vehicle_class_id) return false

  const { data: busyRides } = await supabase.from('rides')
    .select('id')
    .eq('driver_id', driverId)
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .neq('id', ride.id)

  return (busyRides ?? []).length === 0
}

// ── §9.1: Create the manual-capture PaymentIntent ─────────────
// Sets BOTH stripe_payment_intent_id AND payment_status='pending' (§10).
// Includes transfer_data[destination] for Stripe Connect companies so
// capture-payment's transfer_data[amount] doesn't mismatch.
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
  }
  if (company?.stripe_account_id) {
    piBody['transfer_data[destination]'] = company.stripe_account_id
  }

  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
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

  // §10: set BOTH fields so downstream chargers that guard on payment_status skip
  await supabase.from('rides')
    .update({ stripe_payment_intent_id: intent.id, payment_status: 'pending' })
    .eq('id', ride.id)
  console.log(`[ride ${ride.id}] PI created: ${intent.id}`)
  return true
}

async function sendPush(token: string | null | undefined, title: string, body: string, data: Record<string, unknown>) {
  if (!token) return
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
    })
  } catch (e) { console.error('[push]', e) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
