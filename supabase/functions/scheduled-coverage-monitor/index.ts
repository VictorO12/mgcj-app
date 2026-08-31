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
import { DISPATCHABLE_COLUMNS, isDriverDispatchable } from '../_shared/presence.ts'
import { requireServiceRole } from '../_shared/internalAuth.ts'
import { pollPushReceipts } from '../_shared/pushReceipts.ts'
import { sendPushMany } from '../_shared/push.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// Coverage severity: higher = worse
function severity(s: string): number {
  if (s === 'uncovered') return 2
  if (s === 'at_risk')   return 1
  return 0 // covered
}

Deno.serve(async (req) => {
  // Cron/internal only — see _shared/internalAuth.ts. Without this the
  // function is reachable by anyone on the internet: verify_jwt = false in
  // config.toml disables the gateway check entirely.
  const denied = requireServiceRole(req)
  if (denied) return denied
  try {
    const now = new Date()
    console.log(`[coverage-monitor] now=${now.toISOString()}`)

    // Layer 2: reap drivers who left the app online and stopped heartbeating for
    // FOUR HOURS (20260766 — it was 5 minutes, which reaped anyone whose phone
    // was simply locked, since the heartbeat is foreground-only). It no longer
    // clears their location either; last_seen_at already says how old a position
    // is. Still skips any driver on an active ride. Runs before the coverage
    // recompute below so coverage_status reflects the reap in the same pass, and
    // piggybacks this 10-min cron rather than adding one, to avoid growing the
    // pg_cron/pg_net audit tables.
    //
    // At four hours this is garbage collection for a forgotten end-of-shift, not
    // a dispatch safety layer — dispatch now RANKS on liveness instead of
    // excluding (see _shared/presence.ts), and the dashboard derives its own
    // online/away/offline within 60s without needing the flag flipped.
    const { data: reapedRows, error: reapErr } = await supabase.rpc('reap_stale_drivers')
    if (reapErr) {
      console.error('[coverage-monitor] reap error:', JSON.stringify(reapErr))
    } else {
      // The RPC returns rows now, not a count, so `if (reapedRows)` would be
      // true for an empty array — check length.
      const reaped: Array<{ driver_id: string; push_token: string | null }> = reapedRows ?? []
      if (reaped.length > 0) {
        console.log(`[coverage-monitor] reaped ${reaped.length} stale driver(s)`)
        // Tell them. Being switched off silently is how a driver loses a shift
        // to something they cannot see — they keep believing they are online
        // because nothing on their phone said otherwise. The push queues at
        // APNs/FCM and lands whenever they next have signal, which is also when
        // useOnReconnect re-reads is_active and corrects their toggle.
        //
        // Best-effort: a failed notification must never break the coverage pass
        // that follows it, and the reap itself has already been committed.
        try {
          const messages = reaped
            .filter((r) => !!r.push_token)
            .map((r) => ({
              to: r.push_token!,
              title: "You've been set offline",
              body: 'We lost contact with your phone for a few hours. Open the app and go online to start receiving rides again.',
              data: { type: 'driver_reaped' },
            }))
          if (messages.length > 0) await sendPushMany(messages)
        } catch (pushErr) {
          console.error('[coverage-monitor] reap notification failed:', pushErr)
        }
      }
    }

    // Expo push receipts, piggybacked here for the same reason as the reaper
    // above: a dedicated cron would add rows to cron.job_run_details, which has
    // filled the disk once already. This is the half that catches a token which
    // was valid and then died -- uninstall, reinstall, or notifications revoked
    // in OS settings -- since that only ever reports DeviceNotRegistered in the
    // receipt, never in the send-time ticket. Nulling a dead token also drops
    // the driver out of isDriverDispatchable(), which is the point: they were
    // being offered rides their phone could not receive.
    // Failures are logged inside and never block coverage recomputation.
    try {
      await pollPushReceipts()
    } catch (e) {
      console.error('[coverage-monitor] receipt sweep threw:', e)
    }

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
    .select(DISPATCHABLE_COLUMNS)
    .eq('company_id', ride.company_id)

  if (ride.vehicle_class_id) {
    q = q.or(`vehicle_class_id.eq.${ride.vehicle_class_id},vehicle_class_id.is.null`)
  }

  const { data: roster } = await q
  const totalCount  = roster?.length ?? 0
  // Dispatchable, not merely live — must match assign-ride's eligibility or the
  // dashboard reads 'covered' while assign-ride finds nobody to offer.
  const activeCount = (roster ?? []).filter((d: any) => isDriverDispatchable(d)).length

  if (totalCount === 0) return 'uncovered'

  if (ride.preferred_driver_exclusive && ride.preferred_driver_id) {
    const { data: prefD } = await supabase.from('drivers')
      .select(DISPATCHABLE_COLUMNS).eq('id', ride.preferred_driver_id).maybeSingle()
    return prefD && isDriverDispatchable(prefD) ? 'covered' : 'at_risk'
  }

  return activeCount > 0 ? 'covered' : 'at_risk'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
