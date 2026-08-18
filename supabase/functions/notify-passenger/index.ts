import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendPushMany, type PushMessage } from '../_shared/push.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  try {
    const webhookSecret  = Deno.env.get('WEBHOOK_SECRET')
    const incomingSecret = req.headers.get('x-webhook-secret')
    if (!webhookSecret || incomingSecret !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 })
    }

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
      .select('name, push_token, notification_prefs')
      .eq('id', ride.passenger_id)
      .single()

    if (!passengerProfile?.push_token) {
      console.log('No passenger push token')
      return new Response('No passenger push token', { status: 200 })
    }

    // Cancellation notices are safety-critical and always sent regardless of
    // preference; every other status is gated on the ride_updates toggle.
    const rideUpdatesEnabled = passengerProfile.notification_prefs?.ride_updates ?? true
    if (ride.status !== 'cancelled' && !rideUpdatesEnabled) {
      console.log('Passenger has ride_updates notifications off')
      return new Response('Passenger opted out of ride updates', { status: 200 })
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

    const [result] = await sendPushMany([notification as PushMessage])
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