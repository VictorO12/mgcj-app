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

    // Only handle INSERT events on ride_reviews table
    if (body.type !== 'INSERT' || body.table !== 'ride_reviews') {
      return new Response('Not a review insert', { status: 200 })
    }

    const review = body.record
    const { driver_id, rating, ride_id } = review

    console.log(`New review: ride=${ride_id} driver=${driver_id} rating=${rating}`)

    // Get driver's push token
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('push_token')
      .eq('id', driver_id)
      .single()

    if (driverError || !driver?.push_token) {
      console.log('No push token for driver', driver_id)
      return new Response('No push token', { status: 200 })
    }

    // Get passenger name for the message
    const { data: passenger } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', review.passenger_id)
      .single()

    const passengerName = passenger?.name?.split(' ')[0] ?? 'A passenger'

    // Build star string e.g. "⭐⭐⭐⭐⭐"
    const stars = '⭐'.repeat(rating)

    // Compute updated average to include in the notification
    const { data: allRatings } = await supabase
      .from('ride_reviews')
      .select('rating')
      .eq('driver_id', driver_id)

    let avgText = ''
    if (allRatings && allRatings.length > 0) {
      const avg = allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length
      avgText = ` · avg ${avg.toFixed(1)}/5`
    }

    const notification = {
      to: driver.push_token,
      title: `${stars} New rating`,
      body: `${passengerName} rated your ride ${rating}/5${avgText}`,
      data: { type: 'review', rideId: ride_id, rating },
      sound: 'default',
      priority: 'normal',
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
      JSON.stringify({ success: true }),
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