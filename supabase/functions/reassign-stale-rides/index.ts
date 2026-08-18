import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendPush } from '../_shared/push.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const ASSIGN_RIDE_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/assign-ride`
const STALE_THRESHOLD_SECONDS = 60

Deno.serve(async (_req) => {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000).toISOString()

    // §4.1: key staleness off offered_at (not updated_at — that resets on every
    // UPDATE due to the rides_updated_at BEFORE trigger). Drop scheduled_at IS NULL
    // (a holding ride is status='scheduled', so it never matches status='offered').
    // Drop confirmed_by_driver=false (status='offered' already implies unaccepted).
    const { data: staleRides, error } = await supabase
      .from('rides')
      .select('id, driver_id, company_id, pickup_address, scheduled_at, preferred_driver_id, preferred_driver_exclusive, coverage_status')
      .eq('status', 'offered')
      .lt('offered_at', cutoff)

    if (error) {
      console.error('Error fetching stale rides:', error)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    if (!staleRides || staleRides.length === 0) {
      console.log('No stale rides found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    console.log(`Found ${staleRides.length} stale ride(s)`)

    const results = await Promise.all(staleRides.map(ride => handleStaleRide(ride)))

    return new Response(
      JSON.stringify({ processed: staleRides.length, results }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('reassign-stale-rides error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

async function handleStaleRide(ride: any) {
  console.log(`Stale ride ${ride.id} — non-responding driver: ${ride.driver_id}`)

  // §4.2: Exclusive preferred — do NOT fall through to the pool.
  // A stranger is never auto-substituted on an exclusive ride.
  if (
    ride.preferred_driver_exclusive &&
    ride.preferred_driver_id &&
    ride.driver_id === ride.preferred_driver_id
  ) {
    return handleExclusiveStale(ride)
  }

  // Non-exclusive or soft preferred: call assign-ride with timed_out_driver_id
  // so it gets added to timed_out_by (eligible again on second pass) rather
  // than declined_by (permanent exclusion).
  const res = await fetch(ASSIGN_RIDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'x-webhook-secret': Deno.env.get('WEBHOOK_SECRET') ?? '',
    },
    body: JSON.stringify({
      ride_id: ride.id,
      timed_out_driver_id: ride.driver_id,
    }),
  })

  const result = await res.json()
  console.log(`Re-assignment result for ${ride.id}:`, JSON.stringify(result))
  return { rideId: ride.id, path: 'pool_fallthrough', ...result }
}

// §4.2: Exclusive stale-offer handler.
// Re-pings the preferred driver, alerts dispatch once on first degradation,
// resets offered_at so the 60-second window starts fresh.
async function handleExclusiveStale(ride: any) {
  const wasAlreadyAtRisk = ride.coverage_status === 'at_risk'
  const now = new Date().toISOString()

  // Reset offered_at so the 60s window starts over (prevents constant firing).
  // Transition coverage_status to at_risk if not already there.
  await supabase
    .from('rides')
    .update({
      coverage_status: 'at_risk',
      offered_at: now,
    })
    .eq('id', ride.id)
    .eq('status', 'offered')

  // Re-push the preferred driver — keep pinging until dispatch intervenes.
  const { data: preferredDriver } = await supabase
    .from('drivers')
    .select('push_token')
    .eq('id', ride.preferred_driver_id)
    .maybeSingle()

  if (preferredDriver?.push_token) {
    const when = ride.scheduled_at
      ? new Date(ride.scheduled_at).toLocaleString('en-CA', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
        })
      : 'now'
    await sendPush(preferredDriver.push_token,
      '🚗 Ride offer — please respond',
      `${when} · ${ride.pickup_address} — you're the exclusive driver for this ride`,
      { rideId: ride.id, type: 'exclusive_re_offer' }
    )
    console.log(`[ride ${ride.id}] exclusive: re-pushed preferred driver`)
  }

  return { rideId: ride.id, path: 'exclusive_hold', wasAlreadyAtRisk }
}

