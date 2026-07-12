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

const ARRIVAL_BUFFER_MINS = 3

// ── Pick the closest driver from a candidate pool ────────────
// Returns winnerId and their drive time in minutes.
// For scheduled rides, always runs the DM call even for a single candidate
// so leave_by can be accurately stamped.
async function pickWinner(
  candidates: { id: string; current_lat: number; current_lng: number; push_token: string }[],
  pickupLat: number,
  pickupLng: number,
  isScheduled: boolean
): Promise<{ winnerId: string; driveMins: number | null }> {
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

  // Skip DM for a single immediate-ride candidate — no leave_by needed
  if (withDistance.length === 1 && !isScheduled) {
    console.log(`Single candidate: ${withDistance[0].id.slice(0, 8)}`)
    return { winnerId: withDistance[0].id, driveMins: null }
  }

  const driveTimes = await getDriveTimes(
    withDistance.map(d => ({ lat: d.current_lat, lng: d.current_lng, id: d.id })),
    pickupLat,
    pickupLng
  )

  if (driveTimes.size === 0) {
    console.warn('Distance Matrix failed — falling back to Haversine')
    return { winnerId: withDistance[0].id, driveMins: null }
  }

  let bestTime = Infinity
  let winnerId = withDistance[0].id
  for (const [id, seconds] of driveTimes) {
    console.log(`Driver ${id.slice(0, 8)}: ${Math.round(seconds / 60)} min drive`)
    if (seconds < bestTime) { bestTime = seconds; winnerId = id }
  }
  console.log(`Winner: ${winnerId.slice(0, 8)} at ${Math.round(bestTime / 60)} min`)
  return { winnerId, driveMins: bestTime / 60 }
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

  // §5.1: rides without company_id cannot be company-scoped — this is a data
  // integrity issue, not something assign-ride can work around
  if (!ride.company_id) {
    console.error(`Ride ${rideId} has no company_id — cannot scope driver pool`)
    return { success: false, reason: 'no_company_id' }
  }

  const declinedBy: string[] = ride.declined_by ?? []
  const timedOutBy: string[] = ride.timed_out_by ?? []
  console.log(`Assigning ride ${rideId} | declined_by: [${declinedBy.map(id => id.slice(0,8)).join(', ')}] | timed_out_by: [${timedOutBy.map(id => id.slice(0,8)).join(', ')}]`)

  // ── §5.1: Fetch online drivers scoped to THIS company ───────
  let driversQuery = supabase
    .from('drivers')
    .select('id, push_token, current_lat, current_lng')
    .eq('company_id', ride.company_id)
    .eq('is_active', true)
    .not('current_lat', 'is', null)
    .not('current_lng', 'is', null)
    .not('push_token', 'is', null)

  if (ride.vehicle_class_id) {
    driversQuery = driversQuery.eq('vehicle_class_id', ride.vehicle_class_id)
    console.log(`Filtering drivers by vehicle_class_id: ${ride.vehicle_class_id}`)
  }

  const { data: allDrivers, error: driversError } = await driversQuery

  if (driversError || !allDrivers || allDrivers.length === 0) {
    console.log('No online drivers found for this company/vehicle class')
    return { success: false, reason: 'no_drivers' }
  }

  // §5.3: status-only busy filter — confirmed_by_driver removed
  // §5.1: scope busy-ride lookup to same company (cross-company entries
  // can't match allDrivers anyway, but filter keeps intent clear)
  const { data: busyRides } = await supabase
    .from('rides')
    .select('driver_id')
    .eq('company_id', ride.company_id)
    .in('status', ['assigned', 'driver_arriving', 'in_progress'])
    .not('driver_id', 'is', null)

  const busySet = new Set((busyRides ?? []).map((r: any) => r.driver_id))
  const availableDrivers = allDrivers.filter(d => !busySet.has(d.id))

  // ── Two-pass driver selection ────────────────────────────────
  const freshDrivers = availableDrivers.filter(
    d => !declinedBy.includes(d.id) && !timedOutBy.includes(d.id)
  )
  const timedOutDrivers = availableDrivers.filter(
    d => timedOutBy.includes(d.id) && !declinedBy.includes(d.id)
  )

  let candidatePool = freshDrivers
  let pass = 1

  if (candidatePool.length === 0 && timedOutDrivers.length > 0) {
    console.log('No fresh drivers — cycling back to timed-out drivers')
    candidatePool = timedOutDrivers
    await supabase
      .from('rides')
      .update({ timed_out_by: [] })
      .eq('id', rideId)
    pass = 2
  }

  if (candidatePool.length === 0) {
    console.log('All drivers exhausted')
    return { success: false, reason: 'all_declined' }
  }

  console.log(`Pass ${pass}: ${candidatePool.length} candidate(s)`)

  // ── Pick closest driver ──────────────────────────────────────
  const { winnerId, driveMins } = await pickWinner(
    candidatePool, ride.pickup_lat, ride.pickup_lng, !!ride.scheduled_at
  )

  // Stamp leave_by for scheduled rides: pickup_time − drive_time − arrival_buffer.
  // Conservative 15-min fallback when DM was unavailable.
  const now = new Date().toISOString()
  let leaveBy: string | null = null
  let pickupEtaMins: number | null = null
  if (ride.scheduled_at) {
    const effectiveDriveMins = driveMins ?? 15
    leaveBy = new Date(
      new Date(ride.scheduled_at).getTime() - (effectiveDriveMins + ARRIVAL_BUFFER_MINS) * 60_000
    ).toISOString()
    pickupEtaMins = Math.round(effectiveDriveMins)
  }

  // ── §5.4: Assign — set offered_at + assignment_source, optimistic lock ──
  const { data: assignData, error: assignError } = await supabase
    .from('rides')
    .update({
      driver_id: winnerId,
      status: 'offered',
      offered_at: now,
      assignment_source: 'auto_offer',
      ...(leaveBy ? { leave_by: leaveBy, pickup_eta_mins: pickupEtaMins } : {}),
    })
    .eq('id', rideId)
    .eq('status', 'pending')
    .select('id')

  if (assignError || !assignData || assignData.length === 0) {
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

function isServiceRoleJwt(jwt: string): boolean {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]))
    return payload?.role === 'service_role'
  } catch {
    return false
  }
}

// ── Entry point ───────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const webhookSecret  = Deno.env.get('WEBHOOK_SECRET')
    const incomingSecret = req.headers.get('x-webhook-secret')
    const isInternalCall = !!webhookSecret && incomingSecret === webhookSecret

    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!jwt && !isInternalCall) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }

    const isServiceRole = isInternalCall || isServiceRoleJwt(jwt)

    const body = await req.json()
    let rideId: string | undefined
    let declinedByDriverId: string | undefined
    let timedOutDriverId: string | undefined

    if (body.type === 'INSERT' && body.table === 'rides') {
      // DB webhook — must be service-role
      if (!isServiceRole) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      }
      const ride = body.record
      if (ride.status !== 'pending') return new Response('Not pending', { status: 200 })
      if (ride.scheduled_at) return new Response('Scheduled — skipping', { status: 200 })
      rideId = ride.id
    } else if (body.ride_id) {
      rideId = body.ride_id
      declinedByDriverId = body.declined_by_driver_id
      timedOutDriverId = body.timed_out_driver_id

      if (!isServiceRole) {
        // Caller is a driver — verify their identity from the JWT
        const callerClient = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_ANON_KEY')!,
          { global: { headers: { Authorization: authHeader } } }
        )
        const { data: { user }, error: userError } = await callerClient.auth.getUser()
        if (userError || !user) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        }

        const claimedDriverId = declinedByDriverId ?? timedOutDriverId
        if (claimedDriverId && claimedDriverId !== user.id) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
        }
      }
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
