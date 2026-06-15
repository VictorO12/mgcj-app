import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    if (body.type !== 'UPDATE' || body.table !== 'rides') {
      return new Response('Not a ride update', { status: 200 })
    }

    const ride = body.record
    const oldRide = body.old_record

    const statusChanged = ride.status !== oldRide?.status
    const justConfirmed =
      ride.confirmed_by_driver === true &&
      oldRide?.confirmed_by_driver === false

    if (!statusChanged && !justConfirmed) {
      return new Response('No relevant change', { status: 200 })
    }

    const NOTIFY_STATUSES = ['assigned', 'driver_arriving', 'in_progress', 'completed', 'cancelled']
    if (!NOTIFY_STATUSES.includes(ride.status)) {
      return new Response('Status not notifiable', { status: 200 })
    }

    console.log(`Ride ${ride.id} | ${oldRide?.status} → ${ride.status} | confirmed: ${oldRide?.confirmed_by_driver} → ${ride.confirmed_by_driver}`)

    // Get passenger push token
    const { data: passengerProfile } = await supabase
      .from('profiles')
      .select('name, push_token')
      .eq('id', ride.passenger_id)
      .single()

    if (!passengerProfile?.push_token) {
      console.log('No passenger push token')
      return new Response('No passenger push token', { status: 200 })
    }

    // Get driver name
    let driverFirstName = 'Your driver'
    if (ride.driver_id) {
      const { data: driverProfile } = await supabase
        .from('profiles')
        .select('name')
        .eq('id', ride.driver_id)
        .single()
      if (driverProfile?.name) {
        driverFirstName = driverProfile.name.split(' ')[0]
      }
    }

    function formatScheduledTime(iso: string): string {
      return new Date(iso).toLocaleString('en-CA', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    }

    const isScheduled = !!ride.scheduled_at

    let title = ''
    let body_text = ''
    let data: Record<string, any> = { rideId: ride.id, screen: 'ride' }

    switch (ride.status) {
      case 'assigned': {
        // ── KEY FIX: don't notify passenger until driver has confirmed ──
        // assign-ride sets status=assigned with confirmed_by_driver=false.
        // We only want to notify the passenger once the driver taps Accept.
        if (!ride.confirmed_by_driver) {
          return new Response('Driver not yet confirmed — skipping notification', { status: 200 })
        }

        if (isScheduled) {
          const when = formatScheduledTime(ride.scheduled_at)
          title = '🗓️ Scheduled ride confirmed!'
          body_text = `${driverFirstName} has confirmed your ride for ${when}`
        } else {
          title = '🚗 Driver on the way!'
          body_text = `${driverFirstName} has accepted your ride and is heading to pick you up`
        }
        break
      }

      case 'driver_arriving':
        title = '📍 Driver has arrived!'
        body_text = `${driverFirstName} is waiting at your pickup location`
        data.urgent = true
        break

      case 'in_progress':
        title = '🛣️ Ride started'
        body_text = `You're on your way to ${ride.dropoff_address}`
        break

      case 'completed': {
        const fare = ride.fare_final
          ? `$${Number(ride.fare_final).toFixed(2)}`
          : ride.fare_estimate
          ? `$${Number(ride.fare_estimate).toFixed(2)}`
          : ''
        title = '✅ Ride completed!'
        body_text = fare ? `Thanks for riding! Your fare was ${fare}` : 'Thanks for riding!'
        data.screen = 'history'
        break
      }

      case 'cancelled':
        title = '❌ Ride cancelled'
        body_text = 'Your ride has been cancelled. You can book a new one anytime.'
        break

      default:
        return new Response('No notification needed', { status: 200 })
    }

    const notification = {
      to: passengerProfile.push_token,
      title,
      body: body_text,
      data,
      sound: 'default',
      priority: ride.status === 'driver_arriving' ? 'high' : 'normal',
    }

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(notification),
    })

    const result = await response.json()
    console.log('Push result:', JSON.stringify(result))

    return new Response(
      JSON.stringify({ success: true, status: ride.status, scheduled: isScheduled }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('notify-passenger error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})