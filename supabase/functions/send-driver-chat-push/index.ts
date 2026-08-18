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

    // Fired by the driver_chat_messages INSERT webhook
    if (body.type !== 'INSERT' || body.table !== 'driver_chat_messages') {
      return new Response('Not a driver chat insert', { status: 200 })
    }

    const chatMessage = body.record

    // Only dispatch -> driver sends push. A driver's reply shows up on the
    // dashboard, which dispatch is assumed to be watching (same assumption
    // ReportsPage's badge count makes — no push behind it either).
    if (chatMessage.sender_role !== 'admin') {
      return new Response('Driver-sent — no push', { status: 200 })
    }

    const { data: driver, error: driverError } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('id', chatMessage.driver_id)
      .maybeSingle()

    if (driverError) {
      console.error('[send-driver-chat-push] driver lookup error:', JSON.stringify(driverError))
      return new Response('driver lookup error', { status: 500 })
    }
    if (!driver?.push_token) {
      console.log('[send-driver-chat-push] no push token for driver', chatMessage.driver_id)
      return new Response('No push token', { status: 200 })
    }

    const notification = {
      to: driver.push_token,
      title: '💬 Message from dispatch',
      body: chatMessage.body,
      data: { type: 'driver_chat', driverId: chatMessage.driver_id },
      sound: 'default',
      priority: 'high',
    }

    const [result] = await sendPushMany([notification as PushMessage])
    console.log('[send-driver-chat-push] push result:', JSON.stringify(result))

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[send-driver-chat-push] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
