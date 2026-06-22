// supabase/functions/process-scheduled-rides/index.ts

import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const GOOGLE_MAPS_KEY = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY') ?? ''

Deno.serve(async (_req) => {
  try {
    console.log('[process-scheduled-rides] invoked')
    await processScheduledRides()
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[process-scheduled-rides] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

async function processScheduledRides() {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + 35 * 60 * 1000).toISOString()

  console.log(`[process-scheduled-rides] now=${now.toISOString()} windowEnd=${windowEnd}`)

  const { data: rides, error } = await supabase
    .from('rides')
    .select('*')
    .eq('confirmed_by_driver', true)
    .in('status', ['assigned', 'scheduled'])
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', windowEnd)
    .eq('auto_started', false)

  if (error) {
    console.error('[process-scheduled-rides] fetch error:', JSON.stringify(error))
    return
  }

  console.log(`[process-scheduled-rides] found ${rides?.length ?? 0} ride(s)`)

  if (!rides || rides.length === 0) return

  for (const ride of rides) {
    await processRide(ride, now)
  }
}

async function processRide(ride: any, now: Date) {
  const scheduledAt = new Date(ride.scheduled_at)
  const minsUntil = (scheduledAt.getTime() - now.getTime()) / 60000

  console.log(`[ride ${ride.id}] minsUntil=${minsUntil.toFixed(1)} status=${ride.status}`)

  // Fetch driver
  const { data: driver, error: driverErr } = await supabase
    .from('drivers')
    .select('id, push_token, current_lat, current_lng')
    .eq('id', ride.driver_id)
    .single()

  if (driverErr || !driver) {
    console.warn(`[ride ${ride.id}] driver not found:`, JSON.stringify(driverErr))
    return
  }

  console.log(`[ride ${ride.id}] driver push_token=${driver.push_token ? 'present' : 'MISSING'} lat=${driver.current_lat} lng=${driver.current_lng}`)

  // Fetch driver profile for SMS
  const { data: driverProfile } = await supabase
    .from('profiles')
    .select('name, phone')
    .eq('id', ride.driver_id)
    .single()

  // Fetch passenger profile for SMS
  const { data: passengerProfile } = await supabase
    .from('profiles')
    .select('name, phone')
    .eq('id', ride.passenger_id)
    .single()

  // Get travel time driver → pickup
  let travelMins = 0
  if (driver.current_lat && driver.current_lng) {
    travelMins = await getDriverTravelMins(
      driver.current_lat, driver.current_lng,
      ride.pickup_lat, ride.pickup_lng
    )
  }

  console.log(`[ride ${ride.id}] travelMins=${travelMins} minsUntil=${minsUntil.toFixed(1)}`)

  // 30-minute reminder
  if (!ride.notified_30min && minsUntil <= 30 && minsUntil > 15) {
    console.log(`[ride ${ride.id}] sending 30-min reminder`)
    await sendPush(driver.push_token, '🗓 Ride in 30 minutes', `Pickup at ${ride.pickup_address}`, { rideId: ride.id })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Scheduled pickup in 30 minutes at ${ride.pickup_address}.`)
    if (passengerProfile?.phone) await sendSms(passengerProfile.phone, `M&G C&J: Your driver will be at ${ride.pickup_address} in ~30 minutes.`)
    await supabase.from('rides').update({ notified_30min: true }).eq('id', ride.id)
  }

  // 15-minute reminder
  if (!ride.notified_15min && minsUntil <= 15 && minsUntil > 3) {
    console.log(`[ride ${ride.id}] sending 15-min reminder`)
    await sendPush(driver.push_token, '🚗 15 minutes — head to pickup', `Pickup at ${ride.pickup_address}`, { rideId: ride.id })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Scheduled pickup in 15 minutes at ${ride.pickup_address}. Head out soon.`)
    if (passengerProfile?.phone) await sendSms(passengerProfile.phone, `M&G C&J: Your driver will arrive at ${ride.pickup_address} in ~15 minutes.`)
    await supabase.from('rides').update({ notified_15min: true }).eq('id', ride.id)
  }

  // Auto-start: depart now to arrive on time
  const departureThreshold = Math.max(travelMins, 2)
  const shouldStart = minsUntil <= departureThreshold

  console.log(`[ride ${ride.id}] departureThreshold=${departureThreshold} shouldStart=${shouldStart}`)

  if (shouldStart) {
    console.log(`[ride ${ride.id}] AUTO-STARTING`)

    const { error: updateError } = await supabase
      .from('rides')
      .update({ status: 'assigned', auto_started: true, confirmed_by_driver: true })
      .eq('id', ride.id)

    if (updateError) {
      console.error(`[ride ${ride.id}] auto-start update failed:`, JSON.stringify(updateError))
      return
    }

    console.log(`[ride ${ride.id}] status updated to assigned ✓`)

    await sendPush(driver.push_token, '🚦 Ride starting now — head to pickup', `Go to ${ride.pickup_address}`, { rideId: ride.id, type: 'auto_start' })
    if (driverProfile?.phone) await sendSms(driverProfile.phone, `M&G C&J: Your scheduled ride has started. Head to ${ride.pickup_address} now.`)
    if (passengerProfile?.phone) await sendSms(passengerProfile.phone, `M&G C&J: Your driver is on the way to ${ride.pickup_address}.`)
  }
}

async function getDriverTravelMins(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<number> {
  if (!GOOGLE_MAPS_KEY) {
    console.log('[travel] no GOOGLE_MAPS_KEY — defaulting to 0')
    return 0
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${toLat},${toLng}&mode=driving&key=${GOOGLE_MAPS_KEY}`
    const res = await fetch(url)
    const json = await res.json()
    const seconds = json.rows?.[0]?.elements?.[0]?.duration?.value ?? 0
    console.log(`[travel] ${Math.ceil(seconds / 60)} mins`)
    return Math.ceil(seconds / 60)
  } catch (e) {
    console.error('[travel] error:', e)
    return 0
  }
}

async function sendPush(pushToken: string | null, title: string, body: string, data: Record<string, unknown>) {
  if (!pushToken) {
    console.warn('[push] no token — skipping')
    return
  }
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'rides' }),
    })
    const json = await res.json()
    console.log('[push] result:', JSON.stringify(json))
  } catch (e) {
    console.error('[push] error:', e)
  }
}

async function sendSms(phone: string, message: string) {
  try {
    const res = await fetch(
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({ phone, message }),
      }
    )
    const json = await res.json()
    console.log('[sms]', phone, JSON.stringify(json))
  } catch (e) {
    console.error('[sms] error:', e)
  }
}