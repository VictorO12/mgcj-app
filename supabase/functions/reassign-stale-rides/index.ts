import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const ASSIGN_RIDE_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/assign-ride`
const STALE_THRESHOLD_SECONDS = 60

Deno.serve(async (_req) => {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000).toISOString()

    // Find immediate rides assigned to a driver but not confirmed within 60s
    const { data: staleRides, error } = await supabase
      .from('rides')
      .select('id, driver_id, declined_by, pickup_address')
      .eq('status', 'assigned')
      .eq('confirmed_by_driver', false)
      .is('scheduled_at', null)       // immediate rides only
      .lt('updated_at', cutoff)

    if (error) {
      console.error('Error fetching stale rides:', error)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    if (!staleRides || staleRides.length === 0) {
      console.log('No stale rides found')
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 })
    }

    console.log(`Found ${staleRides.length} stale ride(s)`)

    const results = await Promise.all(
      staleRides.map(async (ride) => {
        console.log(`Stale ride ${ride.id} — non-responding driver: ${ride.driver_id}`)

        // Add non-responding driver to declined_by and reset the ride to pending
        const currentDeclined: string[] = ride.declined_by ?? []
        const updatedDeclined = ride.driver_id
          ? [...new Set([...currentDeclined, ride.driver_id])]
          : currentDeclined

        const { error: updateError } = await supabase
          .from('rides')
          .update({
            driver_id: null,
            status: 'pending',
            confirmed_by_driver: false,
            declined_by: updatedDeclined,
          })
          .eq('id', ride.id)
          .eq('status', 'assigned') // guard: don't reset if driver already confirmed

        if (updateError) {
          console.error(`Failed to reset ride ${ride.id}:`, updateError)
          return { rideId: ride.id, success: false }
        }

        // Re-run assign-ride to find the next best available driver
        const res = await fetch(ASSIGN_RIDE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
          body: JSON.stringify({ ride_id: ride.id }),
        })

        const result = await res.json()
        console.log(`Re-assignment result for ${ride.id}:`, JSON.stringify(result))
        return { rideId: ride.id, ...result }
      })
    )

    return new Response(
      JSON.stringify({ processed: staleRides.length, results }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('reassign-stale-rides error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})