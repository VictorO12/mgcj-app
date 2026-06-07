import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY      = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_WEBHOOK_SECRET  = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

// ── Stripe signature verification ─────────────────────────────
// Stripe signs every webhook payload so we can confirm it's genuine
async function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const parts = Object.fromEntries(
      signature.split(',').map(p => p.split('='))
    )
    const timestamp = parts['t']
    const sigHash   = parts['v1']

    if (!timestamp || !sigHash) return false

    // Reject webhooks older than 5 minutes
    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp)
    if (age > 300) return false

    const signedPayload = `${timestamp}.${payload}`
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const rawSig = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(signedPayload)
    )
    const computed = Array.from(new Uint8Array(rawSig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    return computed === sigHash
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload   = await req.text()
    const signature = req.headers.get('stripe-signature') ?? ''

    // ── Verify the webhook is genuinely from Stripe ─────────────
    const valid = await verifyStripeSignature(payload, signature, STRIPE_WEBHOOK_SECRET)
    if (!valid) {
      console.error('Invalid Stripe signature')
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const event = JSON.parse(payload)
    console.log('Stripe webhook received:', event.type)

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // ── Handle events ───────────────────────────────────────────
    switch (event.type) {

      case 'payment_intent.succeeded': {
        const intent  = event.data.object
        const ride_id = intent.metadata?.ride_id

        if (!ride_id) {
          console.warn('payment_intent.succeeded — no ride_id in metadata')
          break
        }

        const { error } = await serviceClient
          .from('rides')
          .update({ payment_status: 'succeeded' })
          .eq('id', ride_id)

        if (error) console.error('Failed to update ride payment_status:', error)
        else console.log(`Ride ${ride_id} marked as succeeded`)
        break
      }

      case 'payment_intent.payment_failed': {
        const intent  = event.data.object
        const ride_id = intent.metadata?.ride_id

        if (!ride_id) {
          console.warn('payment_intent.payment_failed — no ride_id in metadata')
          break
        }

        const { error } = await serviceClient
          .from('rides')
          .update({ payment_status: 'failed' })
          .eq('id', ride_id)

        if (error) console.error('Failed to update ride payment_status:', error)
        else console.log(`Ride ${ride_id} marked as failed`)
        break
      }

      case 'payment_intent.canceled': {
        const intent  = event.data.object
        const ride_id = intent.metadata?.ride_id

        if (!ride_id) break

        await serviceClient
          .from('rides')
          .update({ payment_status: 'unpaid' })
          .eq('id', ride_id)

        console.log(`Ride ${ride_id} payment canceled`)
        break
      }

      case 'charge.refunded': {
        const charge  = event.data.object
        const ride_id = charge.metadata?.ride_id

        if (!ride_id) break

        await serviceClient
          .from('rides')
          .update({ payment_status: 'refunded' })
          .eq('id', ride_id)

        console.log(`Ride ${ride_id} marked as refunded`)
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})