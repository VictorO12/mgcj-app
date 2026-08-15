// Driver-triggered SOFT claim (and un-claim) of a scheduled ride from the
// "Available" board.
//
// Why this needs the service role, like decline-assigned-ride: the live "Drivers
// can update their rides" policy is
//   USING ((driver_id = auth.uid() OR driver_id IS NULL) AND company_id = get_my_company_id())
//   WITH CHECK (driver_id = auth.uid())
// The USING arm does let a driver update an unassigned ride in their company —
// but WITH CHECK forces the resulting row to name them as driver_id. A soft claim
// deliberately leaves driver_id NULL, so it fails the check. The only claim a
// client can write is a HARD one, which is exactly what this replaces.
//
// The claim writes preferred_driver_id + claimed_at and NOTHING else:
//   - driver_id stays NULL, so the ride is still an open scheduled ride.
//   - preferred_driver_exclusive stays false, so scheduled-release's existing
//     soft-preferred path re-confirms the claimant at release and falls through
//     to the pool if they aren't viable. No new dispatch path is introduced.
//   - confirmed_by_driver is NOT set — that belongs to accepting the real offer
//     at release, not to planning to take it hours earlier.
//
// coverage_status is deliberately untouched. A soft claim adds no reachable
// capacity (the pool is still exactly as able to serve the ride as before), and
// every coverage site only treats a preference as capacity when it is EXCLUSIVE
// — see scheduled-coverage-monitor/computeCoverage. Stamping 'covered' off a
// non-binding claim would be the same false-confidence bug the 2026-08-15
// dispatchability fix closed.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

Deno.serve(async (req: Request) => {
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)
    const driverId = userData.user.id

    const { ride_id, action } = await req.json()
    if (!ride_id) return json({ error: 'ride_id required' }, 400)
    if (action !== 'claim' && action !== 'release') {
      return json({ error: "action must be 'claim' or 'release'" }, 400)
    }

    const { data: driver } = await supabase
      .from('drivers')
      .select('id, company_id, vehicle_class_id')
      .eq('id', driverId)
      .maybeSingle()
    if (!driver) return json({ error: 'Not a driver' }, 403)

    const { data: ride } = await supabase
      .from('rides')
      .select('id, status, driver_id, company_id, scheduled_at, vehicle_class_id, preferred_driver_id, preferred_driver_exclusive, claimed_at')
      .eq('id', ride_id)
      .maybeSingle()
    if (!ride) return json({ error: 'Ride not found' }, 404)
    if (ride.company_id !== driver.company_id) return json({ error: 'Not your company' }, 403)

    if (action === 'release') return await releaseClaim(ride, driverId)
    return await claimRide(ride, driver)
  } catch (error) {
    console.error('claim-scheduled-ride error:', error)
    return json({ error: String((error as Error).message ?? error) }, 500)
  }
})

async function claimRide(ride: any, driver: any): Promise<Response> {
  if (ride.status !== 'scheduled') {
    return json({ error: 'This ride has already started dispatching' }, 409)
  }
  if (ride.driver_id) return json({ error: 'Already assigned' }, 409)
  if (ride.preferred_driver_id) {
    // Covers both a dispatch-set preference (dispatch expressed an intent — a
    // driver doesn't get to overwrite it) and another driver's claim.
    return json({ error: 'Already claimed' }, 409)
  }
  if (!ride.scheduled_at || new Date(ride.scheduled_at).getTime() <= Date.now()) {
    return json({ error: 'Pickup time has passed' }, 409)
  }
  // A null vehicle_class_id on the driver means "any class" — same rule
  // scheduled-release's isDriverViable applies.
  if (
    ride.vehicle_class_id &&
    driver.vehicle_class_id !== null &&
    driver.vehicle_class_id !== ride.vehicle_class_id
  ) {
    return json({ error: 'Your vehicle class does not match this ride' }, 403)
  }

  // Race-safe: the guards below make two simultaneous claims a single-row race,
  // same shape as the old .is('driver_id', null) guard. Loser gets 0 rows.
  const { data, error } = await supabase
    .from('rides')
    .update({
      preferred_driver_id:        driver.id,
      preferred_driver_exclusive: false, // a claim is never exclusive
      claimed_at:                 new Date().toISOString(),
    })
    .eq('id', ride.id)
    .eq('status', 'scheduled')
    .is('driver_id', null)
    .is('preferred_driver_id', null)
    .select('id')

  if (error) return json({ error: error.message }, 500)
  if (!data || data.length === 0) return json({ error: 'Already claimed' }, 409)

  console.log(`[ride ${ride.id}] soft-claimed by driver ${driver.id.slice(0, 8)}`)
  return json({ success: true, claimed: true })
}

async function releaseClaim(ride: any, driverId: string): Promise<Response> {
  if (ride.preferred_driver_id !== driverId) {
    return json({ error: 'Not your claim' }, 403)
  }
  // claimed_at null means dispatch set this preference, not the driver. Dispatch
  // preferences are declined through decline-assigned-ride (or simply not
  // accepted at release), never silently dropped from the driver's side.
  if (!ride.claimed_at) {
    return json({ error: 'This ride was assigned to you by dispatch' }, 409)
  }
  if (ride.status !== 'scheduled') {
    return json({ error: 'This ride has already started dispatching' }, 409)
  }

  const { error } = await supabase
    .from('rides')
    .update({
      preferred_driver_id:          null,
      claimed_at:                   null,
      claim_checkin_at:             null,
      claim_hold_projected_free_at: null,
    })
    .eq('id', ride.id)
    .eq('preferred_driver_id', driverId)

  if (error) return json({ error: error.message }, 500)

  console.log(`[ride ${ride.id}] claim released by driver ${driverId.slice(0, 8)}`)
  return json({ success: true, released: true })
}
