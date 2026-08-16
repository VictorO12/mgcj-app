// "If I give this ride to this driver, do they miss their next scheduled
// pickup?" — answered per driver, on demand, for the dashboard's assign picker.
//
// Why this exists rather than the dashboard working it out: the answer needs
// real drive times (driver→pickup, and the trip itself), which come from
// Distance Matrix and only exist server-side. The dashboard was reduced to a
// proxy — "has a commitment in the next N minutes" — which flagged drivers
// hours before they were actually at risk and still couldn't say by how much.
//
// Why not reuse assign-ride's stamped result: that only covers drivers it
// ranked on its last run, and it excludes anyone who declined — so a driver who
// declined lost their conflict warning while being exactly as committed as
// before. Dispatch asks about every driver they can actually pick.
//
// Browser-called: needs the OPTIONS handler and verify_jwt = false (config.toml).
// Caller's JWT and dispatch role are verified below.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  evaluate, COMMITMENT_LOOKAHEAD_MINS, type Commitment,
} from '../_shared/commitment.ts'
import { DISPATCHABLE_COLUMNS, isDriverDispatchable } from '../_shared/presence.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)
const MAPS_KEY = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY')!

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

/** One DM call: many origins → one destination. Returns id → seconds. */
async function driveSeconds(
  origins: { lat: number; lng: number; id: string }[],
  destLat: number, destLng: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (origins.length === 0) return out
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origins.map(o => `${o.lat},${o.lng}`).join('|'))}` +
    `&destinations=${encodeURIComponent(`${destLat},${destLng}`)}` +
    `&key=${MAPS_KEY}&mode=driving`
  const res = await fetch(url)
  const jsonBody = await res.json()
  if (jsonBody.status !== 'OK') {
    console.error('[conflicts] Distance Matrix error:', jsonBody.status)
    return out
  }
  jsonBody.rows.forEach((row: any, i: number) => {
    const el = row.elements[0]
    if (el?.status === 'OK') out.set(origins[i].id, el.duration.value)
  })
  return out
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const { data: userData, error: authError } =
      await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)

    const { data: actor } = await supabase
      .from('profiles').select('id, role, company_id')
      .eq('id', userData.user.id).maybeSingle()
    if (!actor || (actor.role !== 'admin' && actor.role !== 'dispatcher')) {
      return json({ error: 'Dispatch only' }, 403)
    }

    const { ride_id } = await req.json()
    if (!ride_id) return json({ error: 'ride_id required' }, 400)

    const { data: ride } = await supabase
      .from('rides')
      .select('id, company_id, scheduled_at, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
      .eq('id', ride_id).maybeSingle()
    if (!ride) return json({ error: 'Ride not found' }, 404)
    if (ride.company_id !== actor.company_id) return json({ error: 'Not your company' }, 403)

    // The trip starts when it starts: now for an immediate ride, its own pickup
    // time for a scheduled one.
    const startMs = ride.scheduled_at ? new Date(ride.scheduled_at).getTime() : Date.now()

    // Commitments first — if nobody assignable has one, there is nothing to
    // compute and we spend no Distance Matrix elements at all.
    const { data: commitmentRows } = await supabase
      .from('rides')
      .select('id, driver_id, scheduled_at, pickup_lat, pickup_lng')
      .eq('company_id', ride.company_id)
      .eq('confirmed_by_driver', true)
      .not('driver_id', 'is', null)
      .not('scheduled_at', 'is', null)
      .in('status', ['scheduled', 'pending', 'offered', 'assigned'])
      .neq('id', ride_id)
      .gte('scheduled_at', new Date(startMs).toISOString())
      .lte('scheduled_at', new Date(startMs + COMMITMENT_LOOKAHEAD_MINS * 60_000).toISOString())
      .order('scheduled_at', { ascending: true })

    const commitments = new Map<string, Commitment>()
    for (const r of commitmentRows ?? []) {
      if (r.pickup_lat == null || r.pickup_lng == null) continue
      if (!commitments.has(r.driver_id)) {
        commitments.set(r.driver_id, {
          ride_id: r.id, scheduled_at: r.scheduled_at,
          pickup_lat: r.pickup_lat, pickup_lng: r.pickup_lng,
        })
      }
    }
    if (commitments.size === 0) return json({ conflicts: [] })

    // Only drivers dispatch could actually pick. Declined drivers are NOT
    // excluded — dispatch can still hand them the ride manually, so they need
    // an answer too. That's the case assign-ride's stamped result can't cover.
    const { data: driverRows } = await supabase
      .from('drivers')
      .select(`id, current_lat, current_lng, ${DISPATCHABLE_COLUMNS}`)
      .eq('company_id', ride.company_id)
      .in('id', [...commitments.keys()])

    const candidates = (driverRows ?? []).filter(
      (d: any) => isDriverDispatchable(d) && d.current_lat != null && d.current_lng != null
    )
    if (candidates.length === 0) return json({ conflicts: [] })

    const [toPickup, tripLeg] = await Promise.all([
      driveSeconds(
        candidates.map((d: any) => ({ lat: d.current_lat, lng: d.current_lng, id: d.id })),
        ride.pickup_lat, ride.pickup_lng,
      ),
      driveSeconds(
        [{ lat: ride.pickup_lat, lng: ride.pickup_lng, id: 'trip' }],
        ride.dropoff_lat, ride.dropoff_lng,
      ),
    ])
    const tripMins = (tripLeg.get('trip') ?? NaN) / 60

    const conflicts = candidates.map((d: any) => {
      const c = commitments.get(d.id)!
      // A missing drive time yields a non-finite input, and evaluate() fails
      // closed on that — same rule as assign-ride. Never guess against a
      // commitment just because Maps was unavailable.
      const v = evaluate(
        c, startMs, (toPickup.get(d.id) ?? NaN) / 60, tripMins,
        ride.dropoff_lat, ride.dropoff_lng,
      )
      return {
        driver_id: d.id,
        commitment_ride_id: c.ride_id,
        commitment_at: c.scheduled_at,
        ...v,
      }
    })

    console.log(`[conflicts] ride ${ride_id.slice(0, 8)}: ${conflicts.filter(c => c.misses).length}/${conflicts.length} would miss`)
    return json({ conflicts })
  } catch (error) {
    console.error('check-ride-conflicts error:', error)
    return json({ error: String((error as Error).message ?? error) }, 500)
  }
})
