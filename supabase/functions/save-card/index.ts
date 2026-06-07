import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

// ── Stripe helper ─────────────────────────────────────────────
async function stripePost(path: string, body: Record<string, string> = {}) {
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

async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
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

    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Parse request ───────────────────────────────────────────
    // payment_method_id: the pm_xxx token created by Stripe CardField on the app
    const { payment_method_id } = await req.json()
    if (!payment_method_id) {
      return new Response(JSON.stringify({ error: 'payment_method_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // ── Fetch passenger profile ─────────────────────────────────
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id, name, phone, stripe_customer_id')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Get or create Stripe Customer ───────────────────────────
    let stripeCustomerId = profile.stripe_customer_id

    if (!stripeCustomerId) {
      const customer = await stripePost('/customers', {
        name:                         profile.name ?? '',
        phone:                        profile.phone ?? '',
        'metadata[supabase_user_id]': user.id,
      })

      if (customer.error) {
        console.error('Stripe customer creation error:', customer.error)
        return new Response(JSON.stringify({ error: customer.error.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      stripeCustomerId = customer.id

      // Save the customer ID to the profile
      await serviceClient
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', user.id)

      console.log('Created Stripe customer:', stripeCustomerId)
    }

    // ── Attach PaymentMethod to Customer ────────────────────────
    const attached = await stripePost(
      `/payment_methods/${payment_method_id}/attach`,
      { customer: stripeCustomerId }
    )

    if (attached.error) {
      // If already attached to this customer that's fine
      if (!attached.error.message?.includes('already been attached')) {
        console.error('Attach error:', attached.error)
        return new Response(JSON.stringify({ error: attached.error.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // ── Fetch PaymentMethod details for display ─────────────────
    const pm = await stripeGet(`/payment_methods/${payment_method_id}`)
    const card = pm.card ?? {}

    // ── Check how many cards passenger already has ──────────────
    const { count } = await serviceClient
      .from('payment_methods')
      .select('id', { count: 'exact', head: true })
      .eq('passenger_id', user.id)

    const isFirst = (count ?? 0) === 0

    // If this is a new default, unset all existing defaults
    if (isFirst) {
      await serviceClient
        .from('payment_methods')
        .update({ is_default: false })
        .eq('passenger_id', user.id)
    }

    // ── Save to payment_methods table ───────────────────────────
    const { error: insertError } = await serviceClient
      .from('payment_methods')
      .insert({
        passenger_id:             user.id,
        stripe_payment_method_id: payment_method_id,
        brand:                    capitalize(card.brand ?? 'unknown'),
        last4:                    card.last4 ?? '????',
        exp_month:                card.exp_month ?? 0,
        exp_year:                 card.exp_year ?? 0,
        cardholder_name:          pm.billing_details?.name ?? null,
        is_default:               isFirst,
      })

    if (insertError) {
      console.error('DB insert error:', insertError)
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`Card saved for user ${user.id}: ${card.brand} ****${card.last4}`)

    return new Response(
      JSON.stringify({
        success:  true,
        brand:    capitalize(card.brand ?? 'unknown'),
        last4:    card.last4,
        is_default: isFirst,
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}