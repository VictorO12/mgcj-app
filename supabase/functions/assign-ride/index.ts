import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const MAPS_KEY = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY')!

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

async function getDriveTimes(
  origins: { lat: number; lng: number; id: string }[],
  destLat: number,
  destLng: number
): Promise<Map<string, number>> {
  const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|')
  const dest = `${destLat},${destLng}`
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(originsStr)}` +
    `&destinations=${encodeURIComponent(dest)}` +
    `&key=${MAPS_KEY}` +
    `&mode=driving`

  const res = await fetch(url)
  const json = await res.json()
  const result = new Map<string, number>()
  if (json.status !== 'OK') {
    console.error('Distance Matrix error:', json.status)
    return result
  }
  json.rows.forEach((row: any, i: number) => {
    const element = row.elements[0]
    if (element.status === 'OK') result.set(origins[i].id, element.duration.value)
  })
  return result
}

async function notifyDispatchNoDrivers(rideId: string, pickupAddress: string) {
  const { data: dispatchers } = await supabase
    .from('drivers')
    .select('push_token')
    .eq('role', 'dispatch')
    .not('push_token', 'is', null)

  if (!dispatchers || dispatchers.length === 0) return

  const notifications = dispatchers
    .filter(d => d.push_token)
    .map(d => ({
      to: d.push_token,
      title: '⚠️ No drivers available',
      body: `Manual assignment needed: ${pickupAddress}`,
      data: { rideId, type: 'no_drivers' },
      sound: 'default',
      priority: 'high',
    }))

  await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(notifications),
  })
  console.log(`Notified ${notifications.length} dispatcher(s) — no drivers available`)
}

// ── Pick the closest driver from a candidate pool ────────────
async function pickWinner(
  candidates: { id: string; current_lat: number; current_lng: number; push_token: string }[],
  pickupLat: number,
  pickupLng: number
): Promise<string> {
  const withDistance = candidates
    .map(d => ({
      ...d,
      straightLineKm: distanceKm(d.current_lat, d.current_lng, pickupLat, pickupLng),
    }))
    .sort((a, b) => a.straightLineKm - b.straightLineKm)
    .slice(0, 5)

  console.log(
    `Top ${withDistance.length} candidates:`,
    withDistance.map(d => `${d.id.slice(0, 8)} (${d.straightLineKm.toFixed(1)}km)`).join(', ')
  )

  if (withDistance.length === 1) {
    console.log(`Single candidate: ${withDistance[0].id.slice(0, 8)}`)
    return withDistance[0].id
  }

  const driveTimes = await getDriveTimes(
    withDistance.map(d => ({ lat: d.current_lat, lng: d.current_lng, id: d.id })),
    pickupLat,
    pickupLng
  )

  if (driveTimes.size === 0) {
    console.warn('Distance Matrix failed — falling back to Haversine')
    return withDistance[0].id
  }

  let bestTime = Infinity
  let winnerId = withDistance[0].id
  for (const [id, seconds] of driveTimes) {
    console.log(`Driver ${id.slice(0, 8)}: ${Math.round(seconds / 60)} min drive`)
    if (seconds < bestTime) { bestTime = seconds; winnerId = id }
  }
  console.log(`Winner: ${winnerId.slice(0, 8)} at ${Math.round(bestTime / 60)} min`)
  return winnerId
}

async function assignRide(
  rideId: string,
  declinedByDriverId?: string,
  timedOutDriverId?: string
) {
  // ── Handle decline/timeout reset first (server-side, bypasses RLS) ──
  if (declinedByDriverId || timedOutDriverId) {
    const driverId = (declinedByDriverId ?? timedOutDriverId)!
    const isTimeout = !!timedOutDriverId
    console.log(`Driver ${driverId.slice(0, 8)} ${isTimeout ? 'timed out on' : 'declining'} ride ${rideId}`)

    if (isTimeout) {
      // Timeout: add to timed_out_by (eligible again on second pass)
      const { data: current } = await supabase
        .from('rides')
        .select('timed_out_by')
        .eq('id', rideId)
        .single()

      const currentTimedOut: string[] = current?.timed_out_by ?? []
      const updatedTimedOut = [...new Set([...currentTimedOut, driverId])]

      await supabase
        .from('rides')
        .update({ timed_out_by: updatedTimedOut })
        .eq('id', rideId)
    } else {
      // Hard decline: add to declined_by (excluded permanently)
      const { error: rpcError } = await supabase.rpc('append_declined_by', {
        p_ride_id: rideId,
        p_driver_id: driverId,
      })
      if (rpcError) console.error('append_declined_by error:', rpcError)
    }

    // Reset ride to pending for reassignment
    const { error: resetError } = await supabase
      .from('rides')
      .update({
        driver_id: null,
        status: 'pending',
        confirmed_by_driver: false,
      })
      .eq('id', rideId)
      .eq('driver_id', driverId)

    if (resetError) {
      console.error('Failed to reset ride:', resetError)
      return { success: false, reason: 'reset_failed' }
    }

    console.log(`Ride ${rideId} reset to pending`)
  }

  // ── Fetch the ride ───────────────────────────────────────────
  const { data: ride, error: rideError } = await supabase
    .from('rides')
    .select('*')
    .eq('id', rideId)
    .single()

  if (rideError || !ride) {
    console.error('Ride not found:', rideId, rideError)
    return { success: false, reason: 'ride_not_found' }
  }

  if (ride.status !== 'pending') {
    console.log(`Ride ${rideId} is ${ride.status} — skipping`)
    return { success: false, reason: 'not_pending' }
  }

  const declinedBy: string[] = ride.declined_by ?? []
  const timedOutBy: string[] = ride.timed_out_by ?? []
  console.log(`Assigning ride ${rideId} | declined_by: [${declinedBy.map(id => id.slice(0,8)).join(', ')}] | timed_out_by: [${timedOutBy.map(id => id.slice(0,8)).join(', ')}]`)

  // ── Fetch all online drivers ─────────────────────────────────
  const { data: allDrivers, error: driversError } = await supabase
    .from('drivers')
    .select('id, push_token, current_lat, current_lng')
    .eq('is_active', true)
    .not('current_lat', 'is', null)
    .not('current_lng', 'is', null)
    .not('push_token', 'is', null)

  if (driversError || !allDrivers || allDrivers.length === 0) {
    console.log('No online drivers found')
    await notifyDispatchNoDrivers(rideId, ride.pickup_address)
    return { success: false, reason: 'no_drivers' }
  }

  // Filter out drivers on an active confirmed ride
  const { data: busyRides } = await supabase
    .from('rides')
    .select('driver_id')
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .eq('confirmed_by_driver', true)
    .not('driver_id', 'is', null)

  const busySet = new Set((busyRides ?? []).map((r: any) => r.driver_id))
  const availableDrivers = allDrivers.filter(d => !busySet.has(d.id))

  // ── Two-pass driver selection ────────────────────────────────
  // Pass 1: drivers who haven't seen this ride at all
  const freshDrivers = availableDrivers.filter(
    d => !declinedBy.includes(d.id) && !timedOutBy.includes(d.id)
  )

  // Pass 2: drivers who timed out (missed notification) but didn't hard decline
  const timedOutDrivers = availableDrivers.filter(
    d => timedOutBy.includes(d.id) && !declinedBy.includes(d.id)
  )

  let candidatePool = freshDrivers
  let pass = 1

  if (candidatePool.length === 0 && timedOutDrivers.length > 0) {
    // All fresh drivers exhausted — give timed-out drivers another chance
    console.log('No fresh drivers — cycling back to timed-out drivers')
    candidatePool = timedOutDrivers
    // Clear timed_out_by so they each get a full 30s window again
    await supabase
      .from('rides')
      .update({ timed_out_by: [] })
      .eq('id', rideId)
    pass = 2
  }

  if (candidatePool.length === 0) {
    console.log('All drivers exhausted — notifying dispatch')
    await notifyDispatchNoDrivers(rideId, ride.pickup_address)
    return { success: false, reason: 'all_declined' }
  }

  console.log(`Pass ${pass}: ${candidatePool.length} candidate(s)`)

  // ── Pick closest driver ──────────────────────────────────────
  const winnerId = await pickWinner(candidatePool, ride.pickup_lat, ride.pickup_lng)

  // ── Assign — optimistic lock on status = pending ─────────────
  const { error: assignError, count } = await supabase
    .from('rides')
    .update({ driver_id: winnerId, status: 'offered', confirmed_by_driver: false })
    .eq('id', rideId)
    .eq('status', 'pending')
    .select('id', { count: 'exact', head: true })

  if (assignError || count === 0) {
    console.log('Lost race condition or ride no longer pending')
    return { success: false, reason: 'race_condition' }
  }

  console.log(`Ride ${rideId} assigned to driver ${winnerId.slice(0, 8)} (pass ${pass})`)

  // ── Push notification to winning driver ──────────────────────
  const { data: passenger } = await supabase
    .from('profiles').select('name').eq('id', ride.passenger_id).maybeSingle()

  const { data: winnerDriver } = await supabase
    .from('drivers').select('push_token').eq('id', winnerId).maybeSingle()

  if (!winnerDriver?.push_token) {
    console.warn('Winner has no push token — realtime channel will catch it')
    return { success: true, driverId: winnerId }
  }

  const passengerName = passenger?.name ?? 'A passenger'
  const fareText = ride.fare_estimate ? `$${Number(ride.fare_estimate).toFixed(2)}` : 'Cash'

  const pushRes = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([{
      to: winnerDriver.push_token,
      title: '🚗 New ride assigned to you',
      body: `${passengerName} · ${ride.pickup_address} → ${ride.dropoff_address} · ${fareText}`,
      data: {
        rideId: ride.id,
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareEstimate: ride.fare_estimate,
        passengerName,
        type: 'ride_assigned',
      },
      categoryIdentifier: 'RIDE_REQUEST',
      sound: 'default',
      priority: 'high',
      ttl: 90,
    }]),
  })
  const pushResult = await pushRes.json()
  console.log('Push result:', JSON.stringify(pushResult))

  return { success: true, driverId: winnerId, pass }
}

// ── Entry point ───────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const body = await req.json()
    let rideId: string | undefined
    let declinedByDriverId: string | undefined
    let timedOutDriverId: string | undefined

    if (body.type === 'INSERT' && body.table === 'rides') {
      const ride = body.record
      if (ride.status !== 'pending') return new Response('Not pending', { status: 200 })
      if (ride.scheduled_at) return new Response('Scheduled — skipping', { status: 200 })
      rideId = ride.id
    } else if (body.ride_id) {
      rideId = body.ride_id
      declinedByDriverId = body.declined_by_driver_id
      timedOutDriverId = body.timed_out_driver_id
    }

    if (!rideId) return new Response('No ride_id', { status: 400 })

    const result = await assignRide(rideId, declinedByDriverId, timedOutDriverId)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('assign-ride error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})