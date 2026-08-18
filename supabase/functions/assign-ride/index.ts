import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  evaluate, ARRIVAL_BUFFER_MINS, BOARDING_MINS, SAFETY_MARGIN_MINS,
  COMMITMENT_LOOKAHEAD_MINS,
  type Commitment,
} from '../_shared/commitment.ts'
import { livenessOrFilter } from '../_shared/presence.ts'
import { sendPushMany } from '../_shared/push.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

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

// Commitment math lives in _shared/commitment.ts — assign-ride and
// check-ride-conflicts must never disagree about whether a driver can make it.
const MAX_DM_ORIGINS = 8   // cap on DM origins; mirrors scheduled-release's closest-8

function missesCommitment(
  c: Commitment,
  startMs: number,
  driveToPickupMins: number,
  tripMins: number,
  dropoffLat: number, dropoffLng: number,
  driverId = '',
): boolean {
  const v = evaluate(c, startMs, driveToPickupMins, tripMins, dropoffLat, dropoffLng)
  // Every term, every time. Without this a cleared commitment and a commitment
  // that was never found look identical in the logs.
  console.log(
    `[guard] ${driverId.slice(0, 8)} drive=${driveToPickupMins.toFixed(1)} ` +
    `trip=${tripMins.toFixed(1)} | free ${v.free_at ?? '?'} due ${v.due_at} ` +
    `=> ${v.misses ? `MISSES by ${v.minutes_short}m` : `clears by ${-(v.minutes_short ?? 0)}m`}`
  )
  return v.misses
}

// ── Pick the closest ELIGIBLE driver from a candidate pool ───────────────────
// Eligible = fastest to the pickup, and not confirmed for a scheduled pickup
// this trip would make them miss.
//
// The commitment check is a hard skip, not a tiebreak: a scheduled ride is a
// promise already made, and it fails later, invisibly and unrecoverably (the
// passenger is stranded at a time nobody can fix), whereas an unassigned
// immediate ride fails now and visibly, with dispatch able to intervene. When
// the machine refuses, dispatch still has the manual override in
// dispatch-assign-ride — a human who knows the trip is a two-minute hop can
// still make the trade. This only stops the auto-dispatcher from gambling with
// someone else's airport run on a 30-second timer.
interface Guard {
  startMs: number            // when the trip begins: now, or the ride's scheduled_at
  dropoffLat: number
  dropoffLng: number
  commitments: Map<string, Commitment>   // driver id -> soonest confirmed commitment
  tripMins: () => Promise<number | null> // lazy: costs one DM element, only if needed
}

interface Blocked { driver_id: string; ride_id: string; scheduled_at: string }

async function pickWinner(
  candidates: { id: string; current_lat: number; current_lng: number; push_token: string }[],
  pickupLat: number,
  pickupLng: number,
  isScheduled: boolean,
  guard: Guard | null,
): Promise<{ winnerId: string | null; driveMins: number | null; blocked: Blocked[] }> {
  const withDistance = candidates
    .map(d => ({
      ...d,
      straightLineKm: distanceKm(d.current_lat, d.current_lng, pickupLat, pickupLng),
      commitment: guard?.commitments.get(d.id) ?? null,
    }))
    .sort((a, b) => a.straightLineKm - b.straightLineKm)

  // Partition BEFORE slicing. Taking the closest 5 outright can hand back
  // "everyone is committed" while a free driver sits sixth — reachable on a
  // small fleet with a couple of confirmed evening bookings.
  const free      = withDistance.filter(d => !d.commitment)
  const committed = withDistance.filter(d => d.commitment)
  const pool = [...free.slice(0, 5), ...committed.slice(0, 3)]
  for (const d of withDistance) {
    if (pool.length >= MAX_DM_ORIGINS) break
    if (!pool.includes(d)) pool.push(d)
  }
  const hasCommitted = pool.some(d => d.commitment)

  console.log(
    `Top ${pool.length} candidates:`,
    pool.map(d => `${d.id.slice(0, 8)} (${d.straightLineKm.toFixed(1)}km${d.commitment ? ', committed' : ''})`).join(', ')
  )

  // The single-candidate shortcut skips the DM call to save an element. It must
  // NOT apply when that candidate has a commitment: on a small fleet "one
  // candidate left after the busy filter" is the normal case, and skipping the
  // ETA there is exactly where the guard needs to fire.
  if (pool.length === 1 && !isScheduled && !hasCommitted) {
    console.log(`Single candidate: ${pool[0].id.slice(0, 8)}`)
    return { winnerId: pool[0].id, driveMins: null, blocked: [] }
  }

  const driveTimes = await getDriveTimes(
    pool.map(d => ({ lat: d.current_lat, lng: d.current_lng, id: d.id })),
    pickupLat,
    pickupLng
  )

  // Distance Matrix down. Fall back to straight-line order, but drop committed
  // drivers rather than guessing: unknown ETA + a promise to keep resolves the
  // same way the rest of this function does. A Maps outage therefore benches
  // committed drivers instead of risking their pickups.
  if (driveTimes.size === 0) {
    console.warn('Distance Matrix failed — falling back to Haversine')
    const eligible = pool.filter(d => !d.commitment)
    return {
      winnerId: eligible[0]?.id ?? null,
      driveMins: null,
      blocked: eligible.length === 0
        ? pool.map(d => ({ driver_id: d.id, ride_id: d.commitment!.ride_id, scheduled_at: d.commitment!.scheduled_at }))
        : [],
    }
  }

  // One extra element, and only when a candidate actually has something to
  // miss. Most assignments never pay for it.
  const tripMins = guard && hasCommitted ? await guard.tripMins() : null

  const ranked = pool
    .filter(d => driveTimes.has(d.id))
    .sort((a, b) => driveTimes.get(a.id)! - driveTimes.get(b.id)!)

  const blocked: Blocked[] = []
  for (const d of ranked) {
    const mins = driveTimes.get(d.id)! / 60
    console.log(`Driver ${d.id.slice(0, 8)}: ${Math.round(mins)} min drive`)
    if (!d.commitment || !guard) {
      console.log(`Winner: ${d.id.slice(0, 8)} at ${Math.round(mins)} min`)
      return { winnerId: d.id, driveMins: mins, blocked }
    }
    // tripMins null here means the trip-duration lookup failed; same rule as
    // the DM-failure path above — don't guess against a commitment.
    const misses = tripMins === null || missesCommitment(
      d.commitment, guard.startMs, mins, tripMins, guard.dropoffLat, guard.dropoffLng, d.id,
    )
    if (!misses) {
      console.log(`Winner: ${d.id.slice(0, 8)} at ${Math.round(mins)} min (commitment clears)`)
      return { winnerId: d.id, driveMins: mins, blocked }
    }
    console.log(`Held back ${d.id.slice(0, 8)}: due at ${d.commitment.scheduled_at}`)
    blocked.push({
      driver_id: d.id,
      ride_id: d.commitment.ride_id,
      scheduled_at: d.commitment.scheduled_at,
    })
  }

  return { winnerId: null, driveMins: null, blocked }
}

// Dispatch visibility. assign-ride used to give up silently on every one of
// these, leaving the ride to sit `pending` until expire-pending-rides cancelled
// it — dispatch's only clue was noticing a ride that never moved. Written in
// its OWN statement, never merged into the assignment update: the SQL for these
// columns is applied by hand, so a deploy that lands before the migration must
// degrade to "no hold reason", not "every assignment fails".
async function stampHold(
  rideId: string,
  reason: 'no_drivers' | 'all_declined' | 'driver_committed',
  drivers: Blocked[] = [],
) {
  const { error } = await supabase
    .from('rides')
    .update({
      assignment_hold_reason: reason,
      assignment_hold_details: { at: new Date().toISOString(), drivers },
    })
    .eq('id', rideId)
    .eq('status', 'pending')
  if (error) console.warn('[hold] could not stamp', reason, error.message)
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
    .or(livenessOrFilter()) // exclude phantoms: online flag set but heartbeat stale

  if (ride.vehicle_class_id) {
    driversQuery = driversQuery.eq('vehicle_class_id', ride.vehicle_class_id)
    console.log(`Filtering drivers by vehicle_class_id: ${ride.vehicle_class_id}`)
  }

  const { data: allDrivers, error: driversError } = await driversQuery

  if (driversError || !allDrivers || allDrivers.length === 0) {
    console.log('No online drivers found for this company/vehicle class')
    await stampHold(rideId, 'no_drivers')
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

  if (freshDrivers.length === 0 && timedOutDrivers.length === 0) {
    console.log('All drivers exhausted')
    await stampHold(rideId, 'all_declined')
    return { success: false, reason: 'all_declined' }
  }

  // ── Scheduled commitments these drivers have already confirmed ───────────
  // Only confirmed ones count. An unconfirmed dispatch assignment isn't a
  // promise the driver has made yet, and a soft claim is non-binding by
  // design — scheduled-release re-decides it at release precisely because the
  // claimant may be mid-ride, so protecting it here would reintroduce the
  // early binding soft claims exist to avoid.
  const startMs    = ride.scheduled_at ? new Date(ride.scheduled_at).getTime() : Date.now()
  const horizonISO = new Date(startMs + COMMITMENT_LOOKAHEAD_MINS * 60_000).toISOString()
  const candidateIds = new Set(availableDrivers.map(d => d.id))

  // Scoped by company and window, NOT by candidate driver ids. An .in() over
  // the roster looks tighter but doesn't scale: PostgREST puts it in the URL,
  // so a few hundred drivers is a ~12 KB request line, past the usual 8 KB
  // limit — the query 414s and the guard silently stops finding commitments.
  // A company's confirmed scheduled rides in a 3-hour window is a small set at
  // any fleet size; filter to candidates in memory below.
  const { data: commitmentRows } = await supabase
    .from('rides')
    .select('id, driver_id, scheduled_at, pickup_lat, pickup_lng')
    .eq('company_id', ride.company_id)
    .eq('confirmed_by_driver', true)
    .not('driver_id', 'is', null)
    .in('status', ['scheduled', 'pending', 'offered', 'assigned'])
    .not('scheduled_at', 'is', null)
    .neq('id', rideId)
    .gte('scheduled_at', new Date(startMs).toISOString())
    .lte('scheduled_at', horizonISO)
    .order('scheduled_at', { ascending: true })

  const commitments = new Map<string, Commitment>()
  for (const r of commitmentRows ?? []) {
    if (!candidateIds.has(r.driver_id)) continue
    if (r.pickup_lat == null || r.pickup_lng == null) continue
    // Ordered by scheduled_at, so the first one seen is the soonest — the
    // binding one. A later commitment can't be threatened if this one isn't.
    if (!commitments.has(r.driver_id)) {
      commitments.set(r.driver_id, {
        ride_id: r.id,
        scheduled_at: r.scheduled_at,
        pickup_lat: r.pickup_lat,
        pickup_lng: r.pickup_lng,
      })
    }
  }
  console.log(
    `[guard] config arrival=${ARRIVAL_BUFFER_MINS} boarding=${BOARDING_MINS} ` +
    `margin=${SAFETY_MARGIN_MINS} lookahead=${COMMITMENT_LOOKAHEAD_MINS} | ` +
    `window ${new Date(startMs).toISOString()} → ${horizonISO} | ` +
    `${commitmentRows?.length ?? 0} confirmed scheduled ride(s) in window, ` +
    `${commitments.size} held by a candidate driver`
  )

  // Lazy and memoised: one DM element for this trip's own duration, fetched
  // only if a candidate we're actually ranking has a commitment to miss.
  let tripMinsCache: number | null | undefined
  const guard: Guard = {
    startMs,
    dropoffLat: ride.dropoff_lat,
    dropoffLng: ride.dropoff_lng,
    commitments,
    tripMins: async () => {
      if (tripMinsCache !== undefined) return tripMinsCache
      const t = await getDriveTimes(
        [{ lat: ride.pickup_lat, lng: ride.pickup_lng, id: 'trip' }],
        ride.dropoff_lat, ride.dropoff_lng,
      )
      const secs = t.get('trip')
      tripMinsCache = secs === undefined ? null : secs / 60
      console.log(`Trip duration: ${tripMinsCache === null ? 'unavailable' : Math.round(tripMinsCache) + ' min'}`)
      return tripMinsCache
    },
  }

  // ── Two-pass driver selection, guard applied WITHIN each pass ────────────
  // The guard is orthogonal to fresh→timed-out cycling: it filters inside a
  // pass, and only exhausting both passes with nobody eligible is a hold.
  let winnerId: string | null = null
  let driveMins: number | null = null
  let pass = 0
  const blocked: Blocked[] = []

  for (const [n, candidatePool] of [[1, freshDrivers], [2, timedOutDrivers]] as const) {
    if (candidatePool.length === 0) continue
    if (n === 2) {
      console.log('No eligible fresh driver — cycling back to timed-out drivers')
      await supabase.from('rides').update({ timed_out_by: [] }).eq('id', rideId)
    }
    console.log(`Pass ${n}: ${candidatePool.length} candidate(s)`)
    const result = await pickWinner(
      candidatePool, ride.pickup_lat, ride.pickup_lng, !!ride.scheduled_at, guard,
    )
    blocked.push(...result.blocked)
    if (result.winnerId) {
      winnerId  = result.winnerId
      driveMins = result.driveMins
      pass      = n
      break
    }
  }

  if (!winnerId) {
    // Somebody was online and free — they're just already spoken for. That's a
    // different message to dispatch than "nobody is working", and a different
    // decision: the override in dispatch-assign-ride can still place this ride.
    if (blocked.length > 0) {
      console.log(`Held: ${blocked.length} candidate(s) committed to scheduled pickups`)
      await stampHold(rideId, 'driver_committed', blocked)
      return { success: false, reason: 'driver_committed' }
    }
    await stampHold(rideId, 'all_declined')
    return { success: false, reason: 'all_declined' }
  }

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
      // Same statement as the assignment, so a placed ride can never keep a
      // stale "held back" pill on the dashboard.
      assignment_hold_reason: null,
      assignment_hold_details: null,
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

  const [pushResult] = await sendPushMany([{
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
  }])
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
