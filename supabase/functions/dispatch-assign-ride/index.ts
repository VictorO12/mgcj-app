// Dispatch's manual driver assignment / reassignment, moved server-side.
//
// This was a direct client UPDATE from DashboardPage.assignDriver(). It became
// unsafe once drivers could soft-claim scheduled rides (migration 20260743): the
// dashboard set driver_id but left preferred_driver_id/claimed_at pointing at the
// claimant, so on the next scheduled-release tick the ride still looked claimed —
// releaseClaimedRide would evaluate the OLD claimant and, if viable, hand the ride
// straight back to them via releaseToPreferred, silently overwriting dispatch's
// assignment. The same stale field makes reassign-stale-rides treat an immediate
// ('offered') ride as preferred-driver on timeout.
//
// So an override has to clear the claim in the SAME write that sets driver_id.
// Doing that here rather than in the dashboard also gives the displaced driver a
// push — losing a planned ride silently is the failure mode that makes the
// Available board untrustworthy.
//
// logDispatchEvent stays in the dashboard on purpose: it writes dispatch_events
// from the dispatcher's own session, and moving it here would change the actor.
//
// Called from the browser dashboard, so it must handle the CORS preflight and
// be deployed with verify_jwt = false (see config.toml) — the preflight OPTIONS
// carries no Authorization header, so gateway JWT verification 401s it before
// this code runs, and the browser reports it as "CORS header missing" rather
// than as an auth failure. We verify the caller's JWT + dispatch role
// in-function below, so gateway verification is redundant anyway.
//
// This was missing from the day this function was created: every manual assign
// and reassign from the dashboard failed at the preflight, silently, because
// the fetch rejects before any response body exists to alert on.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)

    const { data: actor } = await supabase
      .from('profiles')
      .select('id, role, company_id')
      .eq('id', userData.user.id)
      .maybeSingle()

    if (!actor || (actor.role !== 'admin' && actor.role !== 'dispatcher')) {
      return json({ error: 'Dispatch only' }, 403)
    }

    const { ride_id, driver_id } = await req.json()
    if (!ride_id || !driver_id) return json({ error: 'ride_id and driver_id required' }, 400)

    const { data: ride } = await supabase
      .from('rides')
      .select('id, company_id, status, scheduled_at, driver_id, preferred_driver_id, claimed_at, pickup_address')
      .eq('id', ride_id)
      .maybeSingle()
    if (!ride) return json({ error: 'Ride not found' }, 404)
    if (ride.company_id !== actor.company_id) return json({ error: 'Not your company' }, 403)

    const { data: driver } = await supabase
      .from('drivers')
      .select('id, company_id')
      .eq('id', driver_id)
      .maybeSingle()
    if (!driver || driver.company_id !== ride.company_id) {
      return json({ error: 'Driver not at this company' }, 403)
    }

    // Same branch the dashboard applied: a ride whose pickup is still in the
    // future goes back to 'scheduled' so scheduled-release runs its normal
    // dynamic release; anything due now is offered immediately.
    const isFutureScheduled =
      !!ride.scheduled_at && new Date(ride.scheduled_at).getTime() > Date.now()

    // The displaced claimant is only notified when this was a DRIVER's own claim
    // (claimed_at set) and dispatch is handing the ride to someone else.
    const displacedClaimant =
      ride.claimed_at && ride.preferred_driver_id && ride.preferred_driver_id !== driver_id
        ? ride.preferred_driver_id
        : null

    const { error: updateError } = await supabase
      .from('rides')
      .update({
        driver_id,
        // This override is exactly what the dashboard's "Held back — driver
        // committed" banner tells the dispatcher to do, so it has to clear the
        // hold or the ride keeps the pill after a driver is on it.
        assignment_hold_reason: null,
        assignment_hold_details: null,
        status: isFutureScheduled ? 'scheduled' : 'offered',
        confirmed_by_driver: false,
        ...(isFutureScheduled ? {} : { offered_at: new Date().toISOString() }),
        // Clear the claim in the same write. Left behind, it would let
        // scheduled-release re-offer the ride to the old claimant.
        ...(ride.claimed_at
          ? {
              preferred_driver_id:          null,
              claimed_at:                   null,
              claim_checkin_at:             null,
              claim_hold_projected_free_at: null,
            }
          : {}),
      })
      .eq('id', ride_id)

    if (updateError) return json({ error: updateError.message }, 500)

    if (displacedClaimant) {
      const { data: claimant } = await supabase
        .from('drivers')
        .select('push_token')
        .eq('id', displacedClaimant)
        .maybeSingle()

      if (claimant?.push_token) {
        const when = ride.scheduled_at
          ? new Date(ride.scheduled_at).toLocaleString('en-CA', {
              weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
            })
          : 'your'
        await fetch(EXPO_PUSH_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to:    claimant.push_token,
            title: 'Dispatch reassigned your planned ride',
            body:  `The ${when} pickup at ${ride.pickup_address} has been given to another driver.`,
            data:  { rideId: ride.id, type: 'claim_released', reason: 'dispatch_override' },
            sound: 'default',
          }),
        })
      }
    }

    console.log(
      `[dispatch-assign ${ride.id}] → driver ${driver_id.slice(0, 8)} by ${actor.id.slice(0, 8)}` +
      (displacedClaimant ? ` (displaced claimant ${displacedClaimant.slice(0, 8)})` : '')
    )

    return json({ success: true, displaced_claimant: displacedClaimant })
  } catch (error) {
    console.error('dispatch-assign-ride error:', error)
    return json({ error: String((error as Error).message ?? error) }, 500)
  }
})
