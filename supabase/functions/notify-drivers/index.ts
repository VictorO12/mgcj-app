import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Haversine distance in km between two coordinates
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

serve(async (req) => {
  try {
    const body = await req.json()

    // Only handle INSERT events on rides table
    if (body.type !== 'INSERT' || body.table !== 'rides') {
      return new Response('Not a ride insert', { status: 200 })
    }

    const ride = body.record
    if (ride.status !== 'pending') {
      return new Response('Not a pending ride', { status: 200 })
    }

    console.log('New ride request:', ride.id)

    // Fetch passenger name
    const { data: passenger } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', ride.passenger_id)
      .single()

    // Fetch all online drivers with push tokens and location
    const { data: drivers, error: driversError } = await supabase
      .from('drivers')
      .select('id, push_token, current_lat, current_lng')
      .eq('is_active', true)
      .not('push_token', 'is', null)

    if (driversError || !drivers || drivers.length === 0) {
      console.log('No available drivers with push tokens')
      return new Response('No drivers available', { status: 200 })
    }

    // Sort drivers by distance to pickup location
    const driversWithDistance = drivers
      .filter(d => d.current_lat && d.current_lng)
      .map(d => ({
        ...d,
        distance: distanceKm(
          d.current_lat,
          d.current_lng,
          ride.pickup_lat,
          ride.pickup_lng
        )
      }))
      .sort((a, b) => a.distance - b.distance)

    console.log(`Notifying ${driversWithDistance.length} drivers, closest is ${driversWithDistance[0]?.distance.toFixed(1)}km away`)

    const passengerName = passenger?.name ?? 'A passenger'
    const fareText = ride.fare_estimate ? `$${Number(ride.fare_estimate).toFixed(2)}` : 'Cash'

    // Send push notification to all online drivers
    // Sorted by distance so closest drivers see it first
    const notifications = driversWithDistance.map((driver, index) => ({
      to: driver.push_token,
      title: '🚗 New ride request',
      body: `${passengerName} · ${ride.pickup_address} → ${ride.dropoff_address} · ${fareText}`,
      data: {
        rideId: ride.id,
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareEstimate: ride.fare_estimate,
        passengerName: passengerName,
        distanceKm: driver.distance.toFixed(1),
        priority: index, // 0 = closest
      },
      // Actionable notification buttons
      categoryIdentifier: 'RIDE_REQUEST',
      sound: 'default',
      priority: 'high',
      ttl: 30, // Expire after 30 seconds — matches our in-app timer
    }))

    // Send in batches of 100 (Expo limit)
    const batches = []
    for (let i = 0; i < notifications.length; i += 100) {
      batches.push(notifications.slice(i, i + 100))
    }

    for (const batch of batches) {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(batch),
      })
      const result = await response.json()
      console.log('Push result:', JSON.stringify(result))
    }

    return new Response(
      JSON.stringify({ success: true, notified: driversWithDistance.length }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
