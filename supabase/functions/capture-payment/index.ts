import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

// ── Stripe helper ─────────────────────────────────────────────
async function stripeRequest(path: string, body: Record<string, string> = {}) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  })
  return res.json()
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── Auth check ──────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    // ── Verify the caller is a driver ───────────────────────────
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'driver') {
      return new Response(JSON.stringify({ error: 'Forbidden — drivers only' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Parse request body ──────────────────────────────────────
    const { ride_id } = await req.json()
    if (!ride_id) {
      return new Response(JSON.stringify({ error: 'ride_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Fetch the ride ──────────────────────────────────────────
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: ride, error: rideError } = await serviceClient
      .from('rides')
      .select('id, driver_id, fare_final, fare_estimate, stripe_payment_intent_id, payment_method, payment_status, company_id')
      .eq('id', ride_id)
      .single()

    if (rideError || !ride) {
      return new Response(JSON.stringify({ error: 'Ride not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Guard checks ────────────────────────────────────────────
    if (ride.driver_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden — not your ride' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (ride.payment_method !== 'card') {
      return new Response(JSON.stringify({ error: 'This ride is not a card payment' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (ride.payment_status === 'succeeded') {
      return new Response(JSON.stringify({ error: 'Already captured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!ride.stripe_payment_intent_id) {
      return new Response(JSON.stringify({ error: 'No payment intent found for this ride' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Calculate final capture amount ──────────────────────────
    // Use fare_final if set (driver confirmed actual fare), else fall back to estimate
    const fareAmount = ride.fare_final ?? ride.fare_estimate
    if (!fareAmount || fareAmount <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid fare amount' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch company fee percent to recalculate transfer amount
    const { data: company } = await serviceClient
      .from('companies')
      .select('platform_fee_percent, stripe_account_id')
      .eq('id', ride.company_id)
      .single()

    const feePct        = company?.platform_fee_percent ?? 10
    const totalCents    = Math.round(fareAmount * 100)
    const feeCents      = Math.round(totalCents * (feePct / 100))
    const transferCents = totalCents - feeCents

    // ── Capture the payment intent ──────────────────────────────
    // Stripe will charge the card for exactly this amount
    const captured = await stripeRequest(
      `/payment_intents/${ride.stripe_payment_intent_id}/capture`,
      {
        amount_to_capture:               totalCents.toString(),
        'transfer_data[amount]':         transferCents.toString(),
      }
    )

    if (captured.error) {
      console.error('Stripe capture error:', captured.error)

      // Mark as failed in DB so the app can react
      await serviceClient
        .from('rides')
        .update({ payment_status: 'failed' })
        .eq('id', ride_id)

      return new Response(JSON.stringify({ error: captured.error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Update ride payment status ──────────────────────────────
    // Webhook will also fire payment_intent.succeeded but we update
    // here immediately for a snappy UI response
    await serviceClient
      .from('rides')
      .update({ payment_status: 'succeeded' })
      .eq('id', ride_id)

    console.log(`Ride ${ride_id} captured — $${fareAmount} CAD`)

    return new Response(
      JSON.stringify({
        success:       true,
        amount_cents:  totalCents,
        fee_cents:     feeCents,
        transfer_cents: transferCents,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})