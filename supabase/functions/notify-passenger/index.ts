import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

serve(async (req) => {
  try {
    const body = await req.json()

    // Only handle UPDATE events on rides table
    if (body.type !== 'UPDATE' || body.table !== 'rides') {
      return new Response('Not a ride update', { status: 200 })
    }

    const ride = body.record
    const oldRide = body.old_record

    // Only fire when status actually changed
    if (ride.status === oldRide?.status) {
      return new Response('Status unchanged', { status: 200 })
    }

    // Skip statuses we don't notify on
    const NOTIFY_STATUSES = ['assigned', 'driver_arriving', 'in_progress', 'completed', 'cancelled']
    if (!NOTIFY_STATUSES.includes(ride.status)) {
      return new Response('Status not notifiable', { status: 200 })
    }

    console.log(`Ride ${ride.id} status: ${oldRide?.status} → ${ride.status}`)

    // Get passenger push token
    const { data: passengerProfile } = await supabase
      .from('profiles')
      .select('name, push_token')
      .eq('id', ride.passenger_id)
      .single()

    if (!passengerProfile?.push_token) {
      console.log('No passenger push token found')
      return new Response('No passenger push token', { status: 200 })
    }

    // Get driver name if there is one
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

    // Build notification content based on new status
    let title = ''
    let body_text = ''
    let data: Record<string, any> = { rideId: ride.id, screen: 'ride' }

    switch (ride.status) {
      case 'assigned':
        title = '🚗 Driver on the way!'
        body_text = `${driverFirstName} has accepted your ride and is heading to pick you up`
        break

      case 'driver_arriving':
        title = '📍 Driver has arrived!'
        body_text = `${driverFirstName} is waiting at your pickup location`
        data.urgent = true
        break

      case 'in_progress':
        title = '🛣️ Ride started'
        body_text = `You're on your way to ${ride.dropoff_address}`
        break

      case 'completed':
        const fare = ride.fare_final
          ? `$${Number(ride.fare_final).toFixed(2)}`
          : ride.fare_estimate
          ? `$${Number(ride.fare_estimate).toFixed(2)}`
          : ''
        title = '✅ Ride completed!'
        body_text = fare
          ? `Thanks for riding! Your fare was ${fare}`
          : 'Thanks for riding!'
        data.screen = 'history'
        break

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
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(notification),
    })

    const result = await response.json()
    console.log('Push result:', JSON.stringify(result))

    return new Response(
      JSON.stringify({ success: true, status: ride.status }),
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