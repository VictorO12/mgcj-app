import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

serve(async (_req) => {
  try {
    const now = new Date()
    const nowIso = now.toISOString()

    console.log(`[schedule-rides] Running at ${nowIso}`)

    // ── 1. ACTIVATE rides whose scheduled_at has arrived ─────────
    // Find confirmed scheduled rides where the time has come
    const { data: toActivate, error: activateError } = await supabase
      .from('rides')
      .select('*, profiles!rides_passenger_id_fkey(name, push_token)')
      .in('status', ['pending', 'assigned'])
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', nowIso)
      .eq('auto_started', false)

    if (activateError) {
      console.error('[schedule-rides] activateError:', activateError)
    } else if (toActivate && toActivate.length > 0) {
      console.log(`[schedule-rides] Activating ${toActivate.length} rides`)

      for (const ride of toActivate) {
        // Mark as auto_started so we don't re-process
        await supabase
          .from('rides')
          .update({ auto_started: true })
          .eq('id', ride.id)

        console.log(`[schedule-rides] Activated ride ${ride.id}`)

        // Notify the driver if assigned
        if (ride.driver_id) {
          const { data: driverProfile } = await supabase
            .from('profiles')
            .select('name, push_token')
            .eq('id', ride.driver_id)
            .single()

          if (driverProfile?.push_token) {
            const { data: passengerProfile } = await supabase
              .from('profiles')
              .select('name')
              .eq('id', ride.passenger_id)
              .single()

            await sendPush(driverProfile.push_token, {
              title: '🕐 Scheduled ride starting now',
              body: `Time to pick up ${passengerProfile?.name?.split(' ')[0] ?? 'passenger'} at ${ride.pickup_address}`,
              data: {
                rideId: ride.id,
                type: 'scheduled_start',
                screen: 'active_ride',
              },
              priority: 'high',
            })
          }
        } else {
          // No driver yet — notify all online drivers like a fresh ride
          await supabase.functions.invoke('notify-drivers', {
            body: {
              type: 'INSERT',
              table: 'rides',
              record: { ...ride, status: 'pending' },
            },
          })
        }
      }
    }

    // ── 2. SEND 30-MIN REMINDERS ─────────────────────────────────
    const in30Min = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
    const in31Min = new Date(now.getTime() + 31 * 60 * 1000).toISOString()

    const { data: remind30, error: remind30Error } = await supabase
      .from('rides')
      .select('*, profiles!rides_passenger_id_fkey(name, push_token)')
      .in('status', ['pending', 'assigned'])
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', in30Min)
      .lte('scheduled_at', in31Min)
      .eq('notified_30min', false)

    if (remind30Error) {
      console.error('[schedule-rides] remind30Error:', remind30Error)
    } else if (remind30 && remind30.length > 0) {
      console.log(`[schedule-rides] Sending 30-min reminders for ${remind30.length} rides`)

      for (const ride of remind30) {
        const passenger = (ride as any).profiles
        if (passenger?.push_token) {
          const scheduledTime = new Date(ride.scheduled_at).toLocaleTimeString('en-CA', {
            hour: 'numeric',
            minute: '2-digit',
          })
          await sendPush(passenger.push_token, {
            title: '⏰ Ride in 30 minutes',
            body: `Your ride to ${ride.dropoff_address} is at ${scheduledTime}`,
            data: { rideId: ride.id, screen: 'scheduled' },
          })
        }

        // Also remind the driver if assigned
        if (ride.driver_id) {
          const { data: driverProfile } = await supabase
            .from('profiles')
            .select('name, push_token')
            .eq('id', ride.driver_id)
            .single()

          if (driverProfile?.push_token) {
            const scheduledTime = new Date(ride.scheduled_at).toLocaleTimeString('en-CA', {
              hour: 'numeric',
              minute: '2-digit',
            })
            const { data: passengerProfile } = await supabase
              .from('profiles')
              .select('name')
              .eq('id', ride.passenger_id)
              .single()

            await sendPush(driverProfile.push_token, {
              title: '⏰ Scheduled ride in 30 min',
              body: `Pick up ${passengerProfile?.name?.split(' ')[0] ?? 'passenger'} at ${scheduledTime} from ${ride.pickup_address}`,
              data: { rideId: ride.id, screen: 'scheduled' },
            })
          }
        }

        await supabase
          .from('rides')
          .update({ notified_30min: true })
          .eq('id', ride.id)
      }
    }

    // ── 3. SEND 15-MIN REMINDERS ─────────────────────────────────
    const in15Min = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    const in16Min = new Date(now.getTime() + 16 * 60 * 1000).toISOString()

    const { data: remind15, error: remind15Error } = await supabase
      .from('rides')
      .select('*, profiles!rides_passenger_id_fkey(name, push_token)')
      .in('status', ['pending', 'assigned'])
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', in15Min)
      .lte('scheduled_at', in16Min)
      .eq('notified_15min', false)

    if (remind15Error) {
      console.error('[schedule-rides] remind15Error:', remind15Error)
    } else if (remind15 && remind15.length > 0) {
      console.log(`[schedule-rides] Sending 15-min reminders for ${remind15.length} rides`)

      for (const ride of remind15) {
        const passenger = (ride as any).profiles
        if (passenger?.push_token) {
          await sendPush(passenger.push_token, {
            title: '🚗 Driver heading to you soon',
            body: `Your ride starts in 15 minutes — be ready at ${ride.pickup_address}`,
            data: { rideId: ride.id, screen: 'scheduled' },
            priority: 'high',
          })
        }

        if (ride.driver_id) {
          const { data: driverProfile } = await supabase
            .from('profiles')
            .select('push_token')
            .eq('id', ride.driver_id)
            .single()

          if (driverProfile?.push_token) {
            const { data: passengerProfile } = await supabase
              .from('profiles')
              .select('name')
              .eq('id', ride.passenger_id)
              .single()

            await sendPush(driverProfile.push_token, {
              title: '🚗 Head to pickup in 15 min',
              body: `${passengerProfile?.name?.split(' ')[0] ?? 'Passenger'} is waiting at ${ride.pickup_address}`,
              data: { rideId: ride.id, screen: 'active_ride' },
              priority: 'high',
            })
          }
        }

        await supabase
          .from('rides')
          .update({ notified_15min: true })
          .eq('id', ride.id)
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        activated: toActivate?.length ?? 0,
        reminded30: remind30?.length ?? 0,
        reminded15: remind15?.length ?? 0,
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('[schedule-rides] error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ── Push helper ───────────────────────────────────────────────
async function sendPush(token: string, payload: {
  title: string
  body: string
  data?: Record<string, any>
  priority?: 'default' | 'normal' | 'high'
}) {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: 'default',
        priority: payload.priority ?? 'normal',
      }),
    })
    const result = await res.json()
    console.log('[sendPush] result:', JSON.stringify(result))
  } catch (e) {
    console.error('[sendPush] error:', e)
  }
}