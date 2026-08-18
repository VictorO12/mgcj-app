// Pushes a ride chat message to whichever of the two participants did not send
// it. Fired by a Supabase Database Webhook on INSERT of ride_messages --
// created BY HAND in the dashboard, not by SQL. See section 12 of
// .claude/notes/G3-ride-communications-design.md.
//
// Modelled on send-driver-chat-push, with one structural difference: that
// function only ever pushes in one direction (dispatch -> driver), because a
// driver's reply lands on a dashboard someone is assumed to be watching. Here
// BOTH parties are on a phone with the app backgrounded, so both directions
// push, and the recipient is derived from the ride rather than from the row.
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

    if (body.type !== 'INSERT' || body.table !== 'ride_messages') {
      return new Response('Not a ride message insert', { status: 200 })
    }

    const message = body.record

    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select('id, passenger_id, driver_id, status')
      .eq('id', message.ride_id)
      .maybeSingle()

    if (rideError) {
      console.error('[send-ride-chat-push] ride lookup error:', JSON.stringify(rideError))
      return new Response('ride lookup error', { status: 500 })
    }
    if (!ride) {
      console.log('[send-ride-chat-push] ride gone', message.ride_id)
      return new Response('No ride', { status: 200 })
    }

    // The recipient is the OTHER participant, read off the ride rather than
    // inferred from sender_role -- sender_role's CHECK already admits 'admin'
    // and 'dispatcher' for a possible later dispatch leg (D5), and a
    // role-based switch here would silently push nobody the day that lands.
    const recipientId =
      message.sender_id === ride.passenger_id ? ride.driver_id :
      message.sender_id === ride.driver_id    ? ride.passenger_id :
      null

    if (!recipientId) {
      console.log('[send-ride-chat-push] sender is not a ride participant, no recipient:', message.sender_id)
      return new Response('No recipient', { status: 200 })
    }

    const { data: recipient, error: recipientError } = await supabase
      .from('profiles')
      .select('push_token, role')
      .eq('id', recipientId)
      .maybeSingle()

    if (recipientError) {
      console.error('[send-ride-chat-push] recipient lookup error:', JSON.stringify(recipientError))
      return new Response('recipient lookup error', { status: 500 })
    }
    if (!recipient?.push_token) {
      // Not an error: guest passengers and drivers with a retired token both
      // land here. The thread is still durable, they will see it on next open.
      console.log('[send-ride-chat-push] no push token for', recipientId)
      return new Response('No push token', { status: 200 })
    }

    // Title names the sender's role, not their name: the driver's name is
    // already on the passenger's tracking sheet, and a lock-screen preview is
    // the wrong surface to introduce a name the recipient has not seen yet.
    const title = message.sender_role === 'driver'
      ? '💬 Message from your driver'
      : '💬 Message from your passenger'

    const notification = {
      to: recipient.push_token,
      title,
      body: message.body,
      data: { type: 'ride_chat', rideId: message.ride_id },
      sound: 'default',
      priority: 'high',
    }

    const [result] = await sendPushMany([notification as PushMessage])
    console.log('[send-ride-chat-push] push result:', JSON.stringify(result))

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[send-ride-chat-push] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
