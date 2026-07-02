import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    // Fired by the messages INSERT webhook
    if (body.type !== 'INSERT' || body.table !== 'messages') {
      return new Response('Not a message insert', { status: 200 })
    }

    const message = body.record

    // 1:1 driver messages go through send-driver-chat-push instead.
    if (message.target_type !== 'all_passengers' && message.target_type !== 'all_drivers') {
      return new Response('Unsupported target_type — skipping', { status: 200 })
    }

    const role = message.target_type === 'all_passengers' ? 'passenger' : 'driver'

    const { data: recipients, error: recipientsError } = await supabase
      .from('profiles')
      .select('id, push_token')
      .eq('company_id', message.company_id)
      .eq('role', role)
      .not('push_token', 'is', null)

    if (recipientsError) {
      console.error('[send-message-push] recipients error:', JSON.stringify(recipientsError))
      return new Response('recipients error', { status: 500 })
    }
    if (!recipients || recipients.length === 0) {
      console.log(`[send-message-push] no ${role}s with a push token in company`, message.company_id)
      return new Response('No recipients', { status: 200 })
    }

    const prefix = message.category === 'offer' ? '🏷️' : '📣'

    const notifications = recipients.map((p) => ({
      to: p.push_token,
      title: `${prefix} ${message.title}`,
      body: message.body,
      data: {
        type: 'dispatch_message',
        messageId: message.id,
        category: message.category,
        displayMode: message.display_mode,
      },
      sound: 'default',
      priority: 'high',
    }))

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(notifications),
    })
    const result = await res.json()
    console.log(`[send-message-push] pushed to ${notifications.length} ${role}(s):`, JSON.stringify(result))

    return new Response(JSON.stringify({ ok: true, notified: notifications.length }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[send-message-push] fatal:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
