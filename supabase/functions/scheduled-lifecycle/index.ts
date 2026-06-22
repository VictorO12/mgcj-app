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

  const { data: driver } = await supabase.from('drivers')
    .select('push_token, current_lat, current_lng').eq('id', ride.driver_id).maybeSingle()
  const { data: driverProfile } = await supabase.from('profiles')
    .select('phone').eq('id', ride.driver_id).maybeSingle()
  const { data: pax } = await supabase.from('profiles')
    .select('name, phone, push_token').eq('id', ride.passenger_id).maybeSingle()

  let travelMins = 0
  if (driver?.current_lat && driver?.current_lng) {
    travelMins = await getDriveMins(driver.current_lat, driver.current_lng, ride.pickup_lat, ride.pickup_lng)
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
  const when = new Date(ride.scheduled_at).toLocaleString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' })

  const { data: drivers } = await supabase.from('drivers')
    .select('push_token').eq('company_id', ride.company_id).eq('is_active', true).not('push_token', 'is', null)
  for (const d of drivers ?? []) {
    await sendPush(d.push_token, '🗓 Scheduled ride still open', `${when} · ${ride.pickup_address} — claim it`,
      { rideId: ride.id, type: 'scheduled_offer', scheduledAt: ride.scheduled_at, pickupAddress: ride.pickup_address, dropoffAddress: ride.dropoff_address, fareEstimate: ride.fare_estimate })
  }

  const { data: admins } = await supabase.from('profiles')
    .select('push_token').eq('role', 'admin').eq('company_id', ride.company_id).not('push_token', 'is', null)
  for (const a of admins ?? []) {
    await sendPush(a.push_token, '⚠️ Scheduled ride needs a driver', `${when} pickup at ${ride.pickup_address} — no driver yet`,
      { rideId: ride.id, type: 'dispatch_escalation' })
  }
}

async function getDriveMins(fromLat: number, fromLng: number, toLat: number, toLng: number) {
  if (!MAPS_KEY) return 0
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${toLat},${toLng}&mode=driving&key=${MAPS_KEY}`
    const j = await (await fetch(url)).json()
    return Math.ceil((j.rows?.[0]?.elements?.[0]?.duration?.value ?? 0) / 60)
  } catch (e) { console.error('[drive]', e); return 0 }
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