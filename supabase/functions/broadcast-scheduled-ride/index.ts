import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    // Fired by the rides INSERT webhook
    if (body.type !== 'INSERT' || body.table !== 'rides') {
      return new Response('Not a ride insert', { status: 200 })
    }

    const ride = body.record

    // Only act on freshly created scheduled rides
    if (!ride.scheduled_at || ride.status !== 'scheduled') {
      return new Response('Not a new scheduled ride — skipping', { status: 200 })
    }

    if (ride.driver_id) {
      return new Response('Already has a driver — skipping', { status: 200 })
    }
    if (!ride.company_id) {
      console.warn(`[broadcast-scheduled] ride ${ride.id} has no company_id — skipping`)
      return new Response('No company', { status: 200 })
    }

    console.log(`[broadcast-scheduled] ride ${ride.id} company ${ride.company_id} at ${ride.scheduled_at}`)

    const { data: passenger } = await supabase
      .from('profiles').select('name').eq('id', ride.passenger_id).maybeSingle()

    // Drivers currently on an active confirmed ride — exclude them
    const { data: busyRides } = await supabase
      .from('rides')
      .select('driver_id')
      .in('status', ['assigned', 'driver_arriving', 'in_progress'])
      .eq('confirmed_by_driver', true)
      .not('driver_id', 'is', null)
    const busy = new Set((busyRides ?? []).map((r: any) => r.driver_id))

      // Online drivers in THIS company with a push token
    const { data: drivers, error: driversError } = await supabase
      .from('drivers')
      .select('id, push_token')
      .eq('company_id', ride.company_id)
      .eq('is_active', true)
      .not('push_token', 'is', null)

    if (driversError) {
      console.error('[broadcast-scheduled] drivers error:', JSON.stringify(driversError))
      return new Response('drivers error', { status: 500 })
    }
    if (!drivers || drivers.length === 0) {
      // Not a failure — ride stays on the board; the lifecycle cron escalates near pickup
      console.log('[broadcast-scheduled] no online drivers in company — leaving on board')
      return new Response('No drivers online', { status: 200 })
    }

    const passengerName = passenger?.name ?? 'A passenger'
    const fareText = ride.fare_estimate ? `$${Number(ride.fare_estimate).toFixed(2)}` : 'Cash'
    const when = new Date(ride.scheduled_at).toLocaleString('en-CA', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Halifax',
    })

    const messages = drivers.filter(d => d.push_token && !busy.has(d.id)).map(d => ({
      to: d.push_token,
      title: '🗓 Scheduled ride available',
      body: `${when} · ${ride.pickup_address} → ${ride.dropoff_address} · ${fareText}`,
      data: {
        rideId: ride.id,
        type: 'scheduled_offer',
        scheduledAt: ride.scheduled_at,
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareEstimate: ride.fare_estimate,
        passengerName,
      },
      categoryIdentifier: 'SCHEDULED_OFFER',
      sound: 'default',
      priority: 'high',
    }))

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })
    const result = await res.json()
    console.log(`[broadcast-scheduled] pushed to ${messages.length} driver(s):`, JSON.stringify(result))

    return new Response(JSON.stringify({ ok: true, notified: messages.length }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[broadcast-scheduled] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})