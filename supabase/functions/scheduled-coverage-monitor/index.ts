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

  if (degraded) {
    await alertDispatch(ride, newCoverage, minsUntil)
  }

  // ── Passenger reminders (T-30 and T-15) ─────────────────────
  // Driver-independent — the driver isn't assigned until release (~T-30).
  await maybeSendPassengerReminder(ride, minsUntil)
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

async function alertDispatch(ride: any, newCoverage: string, minsUntil: number) {
  if (!ride.company_id) return

  const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
  })

  let title: string
  let body: string
  if (newCoverage === 'uncovered') {
    title = '🚨 Scheduled ride — no eligible drivers'
    body  = `${when} · ${ride.pickup_address} — no driver of this class in fleet`
  } else {
    title = '⚠️ Scheduled ride at risk'
    body  = ride.preferred_driver_exclusive
      ? `${when} · ${ride.pickup_address} — exclusive driver is offline`
      : `${when} · ${ride.pickup_address} — no active drivers currently online`
  }

  const { data: admins } = await supabase.from('profiles')
    .select('push_token')
    .eq('role', 'admin')
    .eq('company_id', ride.company_id)
    .not('push_token', 'is', null)

  for (const admin of admins ?? []) {
    await sendPush(admin.push_token, title, body,
      { rideId: ride.id, type: 'coverage_degraded', coverage: newCoverage })
  }
  console.log(`[ride ${ride.id}] degradation alert → ${newCoverage} (${minsUntil.toFixed(0)} min out), notified ${admins?.length ?? 0} admin(s)`)
}

async function maybeSendPassengerReminder(ride: any, minsUntil: number) {
  if (!ride.passenger_id) return

  const { data: pax } = await supabase.from('profiles')
    .select('name, phone, push_token').eq('id', ride.passenger_id).maybeSingle()

  const when = new Date(ride.scheduled_at).toLocaleTimeString('en-CA', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
  })

  // T-30 window: 29–31 minutes out
  if (!ride.notified_30min && minsUntil <= 31 && minsUntil > 29) {
    if (pax?.push_token) {
      await sendPush(pax.push_token,
        '⏰ Ride in 30 minutes',
        `Your driver will be on the way to ${ride.pickup_address} soon`,
        { rideId: ride.id, type: 'reminder_30min' }
      )
    }
    if (pax?.phone) {
      await sendSms(pax.phone, `M&G C&J: Your ride at ${when} — your driver will be on the way to ${ride.pickup_address} very soon.`)
    }
    await supabase.from('rides').update({ notified_30min: true }).eq('id', ride.id)
    console.log(`[ride ${ride.id}] sent T-30 passenger reminder`)
  }

  // T-15 window: 14–16 minutes out
  if (!ride.notified_15min && minsUntil <= 16 && minsUntil > 14) {
    if (pax?.push_token) {
      await sendPush(pax.push_token,
        '🚗 Driver heading your way soon',
        `Be ready at ${ride.pickup_address} — your ride is at ${when}`,
        { rideId: ride.id, type: 'reminder_15min' }
      )
    }
    if (pax?.phone) {
      await sendSms(pax.phone, `M&G C&J: Your ride is at ${when}. Be ready at ${ride.pickup_address} — your driver is on the way shortly.`)
    }
    await supabase.from('rides').update({ notified_15min: true }).eq('id', ride.id)
    console.log(`[ride ${ride.id}] sent T-15 passenger reminder`)
  }
}

async function sendPush(token: string | null | undefined, title: string, body: string, data: Record<string, unknown>) {
  if (!token) return
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
    })
  } catch (e) { console.error('[push]', e) }
}

async function sendSms(phone: string, message: string) {
  try {
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ phone, message }),
    })
  } catch (e) { console.error('[sms]', e) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
