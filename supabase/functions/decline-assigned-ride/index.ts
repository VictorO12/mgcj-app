// Driver-triggered decline of a dispatch-assigned ride that hasn't been
// confirmed yet. Handles the case AssignedRideScreen / AssignedRidesListScreen
// cover: a future scheduled ride dispatch assigned directly to a driver
// (status stays 'scheduled' the whole time — it never goes through 'offered').
// A direct client-side `.update({ driver_id: null, ... })` cannot do this: RLS
// requires driver_id = auth.uid() on both the OLD and NEW row for a driver's
// own UPDATE, so a driver can never null their own driver_id from the client.
// This function runs with the service role to do it safely, and — unlike a
// bare unassign — records the decline and alerts dispatch so it's visible.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { DISPATCHABLE_COLUMNS, isDriverDispatchable } from '../_shared/presence.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response('Unauthorized', { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) {
      return new Response('Unauthorized', { status: 401 })
    }
    const driverId = userData.user.id

    const { ride_id } = await req.json()
    if (!ride_id) {
      return new Response(JSON.stringify({ error: 'ride_id required' }), { status: 400 })
    }

    const { data: ride, error: fetchError } = await supabase
      .from('rides')
      .select('id, driver_id, confirmed_by_driver, status, company_id, pickup_address, scheduled_at, vehicle_class_id, preferred_driver_id, preferred_driver_exclusive')
      .eq('id', ride_id)
      .maybeSingle()

    if (fetchError || !ride) {
      return new Response(JSON.stringify({ error: 'Ride not found' }), { status: 404 })
    }
    if (ride.driver_id !== driverId) {
      return new Response(JSON.stringify({ error: 'Not your ride' }), { status: 403 })
    }
    if (ride.confirmed_by_driver) {
      return new Response(JSON.stringify({ error: 'Already confirmed — cannot decline' }), { status: 409 })
    }
    if (ride.status !== 'scheduled') {
      return new Response(JSON.stringify({ error: `Cannot decline a ride in status '${ride.status}'` }), { status: 409 })
    }

    // Recompute coverage the same way broadcast-scheduled-ride does at
    // booking time — a decline just returns the ride to "unassigned", not
    // necessarily "no eligible driver exists". Roster scope follows the
    // ride's vehicle_class_id (none = any class counts).
    let driversQuery = supabase
      .from('drivers')
      .select(DISPATCHABLE_COLUMNS)
      .eq('company_id', ride.company_id)
    if (ride.vehicle_class_id) {
      driversQuery = driversQuery.eq('vehicle_class_id', ride.vehicle_class_id)
    }
    const { data: roster } = await driversQuery
    const totalCount = roster?.length ?? 0
    // Dispatchable, not merely live — see the note in _shared/presence.ts.
    const activeCount = (roster ?? []).filter((d: any) => isDriverDispatchable(d)).length

    let newCoverage: 'uncovered' | 'at_risk' | 'covered'
    if (totalCount === 0) {
      newCoverage = 'uncovered'
    } else if (ride.preferred_driver_exclusive && ride.preferred_driver_id) {
      const { data: prefD } = await supabase.from('drivers')
        .select(DISPATCHABLE_COLUMNS).eq('id', ride.preferred_driver_id).maybeSingle()
      newCoverage = prefD && isDriverDispatchable(prefD) ? 'covered' : 'at_risk'
    } else if (activeCount === 0) {
      newCoverage = 'at_risk'
    } else {
      newCoverage = 'covered'
    }

    const { error: updateError } = await supabase
      .from('rides')
      .update({
        driver_id: null,
        confirmed_by_driver: false,
        coverage_status: newCoverage,
      })
      .eq('id', ride_id)
      .eq('driver_id', driverId)

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500 })
    }

    const { error: rpcError } = await supabase.rpc('append_declined_by', {
      p_ride_id: ride_id,
      p_driver_id: driverId,
    })
    if (rpcError) console.error('append_declined_by error:', rpcError)

    // Dispatch works from the dashboard, not push — the coverage_status flip
    // above is what surfaces this: it drives the existing Realtime coverage
    // toast + per-card pill on DashboardPage, same as any other degradation.
    console.log(`[ride ${ride.id}] declined by driver ${driverId}, coverage_status -> ${newCoverage}`)

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('decline-assigned-ride error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
