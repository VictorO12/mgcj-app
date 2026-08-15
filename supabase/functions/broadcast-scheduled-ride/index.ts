// §6: Repurposed from "claim-it" broadcast to booking-time coverage check.
// Fires on rides INSERT (webhook already wired: broadcast_scheduled_ride_on_insert).
// New behavior for status='scheduled' rides:
//   1. Compute coverage_status and stamp it on the ride.
//   2. If uncovered → alert dispatch immediately (find out days out, not T-60).
//   3. If preferred_driver_id set and not yet notified → send non-binding heads-up.
//
// Advance driver claim-solicitation is removed — that path is gone.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { DISPATCHABLE_COLUMNS, isDriverDispatchable } from '../_shared/presence.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL    = 'https://exp.host/--/api/v2/push/send'
const RELEASE_LEAD_MINS = 30

Deno.serve(async (req) => {
  try {
    const webhookSecret  = Deno.env.get('WEBHOOK_SECRET')
    const incomingSecret = req.headers.get('x-webhook-secret')
    if (!webhookSecret || incomingSecret !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 })
    }

    const body = await req.json()

    if (body.type !== 'INSERT' || body.table !== 'rides') {
      return new Response('Not a ride insert', { status: 200 })
    }

    const ride = body.record

    if (!ride.scheduled_at || ride.status !== 'scheduled') {
      return new Response('Not a new scheduled ride — skipping', { status: 200 })
    }

    if (!ride.company_id) {
      console.warn(`[coverage-check] ride ${ride.id} has no company_id — skipping`)
      return new Response('No company', { status: 200 })
    }

    console.log(`[coverage-check] ride ${ride.id} company ${ride.company_id} at ${ride.scheduled_at}`)

    // ── Compute coverage ─────────────────────────────────────────
    // Count all roster drivers (online or not) matching the required class.
    // "uncovered" = no driver of this class exists at all (can't be served
    //   without adding a driver to the fleet).
    // "at_risk"   = drivers exist but none are currently active, OR
    //               exclusive ride and the preferred driver is offline.
    // "covered"   = at least one active eligible driver exists.

    let driversQuery = supabase
      .from('drivers')
      .select(DISPATCHABLE_COLUMNS)
      .eq('company_id', ride.company_id)

    if (ride.vehicle_class_id) {
      driversQuery = driversQuery.eq('vehicle_class_id', ride.vehicle_class_id)
    }

    const { data: roster } = await driversQuery
    const totalCount  = roster?.length ?? 0
    // Dispatchable, not merely live — see the note in _shared/presence.ts.
    const activeCount = (roster ?? []).filter((d: any) => isDriverDispatchable(d)).length

    let newCoverage: 'uncovered' | 'at_risk' | 'covered'
    if (totalCount === 0) {
      newCoverage = 'uncovered'
    } else if (ride.preferred_driver_exclusive && ride.preferred_driver_id) {
      // Exclusive: coverage is entirely determined by that one driver's status
      const { data: prefD } = await supabase.from('drivers')
        .select(DISPATCHABLE_COLUMNS).eq('id', ride.preferred_driver_id).maybeSingle()
      newCoverage = prefD && isDriverDispatchable(prefD) ? 'covered' : 'at_risk'
    } else if (activeCount === 0) {
      newCoverage = 'at_risk'
    } else {
      newCoverage = 'covered'
    }

    await supabase.from('rides')
      .update({ coverage_status: newCoverage })
      .eq('id', ride.id)

    console.log(`[coverage-check] ride ${ride.id} coverage=${newCoverage}`)

    // ── §8: Non-binding advance heads-up to preferred driver ─────
    if (ride.preferred_driver_id && !ride.preferred_notified) {
      const { data: prefDriver } = await supabase.from('drivers')
        .select('push_token').eq('id', ride.preferred_driver_id).maybeSingle()

      if (prefDriver?.push_token) {
        const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
        })
        const releaseAt = new Date(new Date(ride.scheduled_at).getTime() - RELEASE_LEAD_MINS * 60_000)
        const releaseWhen = releaseAt.toLocaleTimeString('en-CA', {
          hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax',
        })

        await sendPush(prefDriver.push_token,
          "🗓 You're the preferred driver",
          `Scheduled ride at ${when}. You'll get the offer around ${releaseWhen}.`,
          { rideId: ride.id, type: 'preferred_heads_up', scheduledAt: ride.scheduled_at }
        )

        await supabase.from('rides')
          .update({ preferred_notified: true })
          .eq('id', ride.id)

        console.log(`[coverage-check] sent preferred heads-up to driver ${ride.preferred_driver_id.slice(0, 8)}`)
      }
    }

    return new Response(
      JSON.stringify({ ok: true, coverage: newCoverage }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[coverage-check] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})

async function sendPush(token: string, title: string, body: string, data: Record<string, unknown>) {
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
    })
  } catch (e) {
    console.error('[push]', e)
  }
}
