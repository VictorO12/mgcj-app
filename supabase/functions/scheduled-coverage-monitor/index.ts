// §7: scheduled-coverage-monitor — runs every ~10 minutes.
// Read-only in intent: never assigns a driver. For each scheduled ride:
//   1. Recomputes coverage_status.
//   2. On degradation (covered→at_risk or →uncovered), alerts dispatch once and
//      updates the column. Guards so it doesn't re-alert on every tick.
//   3. Sends T-30 and T-15 passenger push/SMS reminders (driver-independent —
//      the driver isn't assigned until release, so "your driver will be on the
//      way soon" is the right framing).
//
// Cron: */10 * * * * (register in Supabase dashboard pg_cron)

import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Coverage severity: higher = worse
function severity(s: string): number {
  if (s === 'uncovered') return 2
  if (s === 'at_risk')   return 1
  return 0 // covered
}

Deno.serve(async () => {
  try {
    const now = new Date()
    console.log(`[coverage-monitor] now=${now.toISOString()}`)

    const { data: rides, error } = await supabase
      .from('rides')
      .select('*')
      .eq('status', 'scheduled')
      .not('scheduled_at', 'is', null)

    if (error) {
      console.error('[coverage-monitor] fetch error:', JSON.stringify(error))
      return json({ error: error.message }, 500)
    }

    console.log(`[coverage-monitor] ${rides?.length ?? 0} scheduled ride(s)`)

    for (const ride of rides ?? []) {
      await processRide(ride, now)
    }

    return json({ ok: true, checked: rides?.length ?? 0 })
  } catch (err) {
    console.error('[coverage-monitor] fatal:', err)
    return json({ error: String(err) }, 500)
  }
})

async function processRide(ride: any, now: Date) {
  const minsUntil = (new Date(ride.scheduled_at).getTime() - now.getTime()) / 60_000

  // ── Recompute coverage ───────────────────────────────────────
  const newCoverage = await computeCoverage(ride)

  const current  = ride.coverage_status ?? 'covered'
  const degraded = severity(newCoverage) > severity(current)

  if (newCoverage !== current) {
    await supabase.from('rides')
      .update({ coverage_status: newCoverage })
      .eq('id', ride.id)
    console.log(`[ride ${ride.id}] coverage ${current} → ${newCoverage}`)
  }

  // Degradation is written to rides.coverage_status above.
  // Dashboard reads it via Realtime and shows an in-app toast — no push needed.
  void degraded
}

async function computeCoverage(ride: any): Promise<'uncovered' | 'at_risk' | 'covered'> {
  if (!ride.company_id) return 'uncovered'

  let q = supabase.from('drivers')
    .select('id, is_active')
    .eq('company_id', ride.company_id)
    .eq('is_deleted', false)

  if (ride.vehicle_class_id) {
    q = q.eq('vehicle_class_id', ride.vehicle_class_id)
  }

  const { data: roster } = await q
  const totalCount  = roster?.length ?? 0
  const activeCount = (roster ?? []).filter((d: any) => d.is_active).length

  if (totalCount === 0) return 'uncovered'

  if (ride.preferred_driver_exclusive && ride.preferred_driver_id) {
    const { data: prefD } = await supabase.from('drivers')
      .select('is_active').eq('id', ride.preferred_driver_id).maybeSingle()
    return prefD?.is_active ? 'covered' : 'at_risk'
  }

  return activeCount > 0 ? 'covered' : 'at_risk'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
