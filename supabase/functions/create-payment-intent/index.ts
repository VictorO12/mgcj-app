import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

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

function declineMessage(code?: string): string {
  switch (code) {
    case 'insufficient_funds':
      return 'Your card was declined due to insufficient funds. Please check your balance or use a different card.'
    case 'card_declined':
      return 'Your card was declined. Please try a different card or pay with cash.'
    case 'expired_card':
      return 'Your card has expired. Please add a new card.'
    case 'incorrect_cvc':
      return 'Your card security code is incorrect. Please update your card details.'
    case 'lost_card':
    case 'stolen_card':
      return 'This card cannot be used. Please add a different card.'
    default:
      return 'Payment failed. Please try a different card or pay with cash.'
  }
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
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { fare_amount, discount_code } = await req.json()

    if (!fare_amount || fare_amount <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid fare amount' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch passenger Stripe customer ID + company (for discount eligibility)
    const { data: passenger } = await serviceClient
      .from('profiles')
      .select('stripe_customer_id, company_id')
      .eq('id', user.id)
      .single()

    if (!passenger?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'No saved payment method found. Please add a card first.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch passenger default card
    const { data: paymentMethod } = await serviceClient
      .from('payment_methods')
      .select('stripe_payment_method_id')
      .eq('passenger_id', user.id)
      .eq('is_default', true)
      .single()

    if (!paymentMethod?.stripe_payment_method_id) {
      return new Response(JSON.stringify({ error: 'No default payment method found. Please add a card first.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Apply student discount (always wins) or a discount code, if eligible —
    // see compute_discount_for_booking for the priority rules.
    let discountedFare = fare_amount
    let discountAmount = 0
    let discountType: string | null = null
    let discountCodeId: string | null = null
    if (passenger.company_id) {
      const { data: discount } = await serviceClient
        .rpc('compute_discount_for_booking', {
          p_user_id:    user.id,
          p_company_id: passenger.company_id,
          p_fare:       fare_amount,
          p_code:       discount_code ?? null,
        })
        .maybeSingle()

      if (discount) {
        discountedFare = discount.discounted_fare ?? fare_amount
        discountAmount = discount.discount_amount ?? 0
        discountType = discount.discount_type ?? null
        discountCodeId = discount.code_id ?? null
      }
    }

    // Use platform fee default — actual fee % recalculated against the
    // company at capture time in capture-payment, off the discounted fare.
    const platformFeePercent = 10.0
    const totalCents         = Math.round(discountedFare * 100)
    const feeCents           = Math.round(totalCents * (platformFeePercent / 100))

    // Create PaymentIntent with manual capture (hold only)
    const intent = await stripePost('/payment_intents', {
      amount:                                       totalCents.toString(),
      currency:                                     'cad',
      customer:                                     passenger.stripe_customer_id,
      payment_method:                               paymentMethod.stripe_payment_method_id,
      capture_method:                               'manual',
      confirm:                                      'true',
      'automatic_payment_methods[enabled]':         'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[passenger_id]':                     user.id,
      'metadata[platform_fee_cents]':               feeCents.toString(),
      'metadata[pre_discount_fare]':                fare_amount.toString(),
      'metadata[discount_amount]':                  discountAmount.toString(),
    })

    if (intent.error) {
      console.error('Stripe error:', intent.error)
      const message = declineMessage(intent.error.decline_code ?? intent.error.code)
      return new Response(
        JSON.stringify({
          error:        'payment_failed',
          message,
          decline_code: intent.error.decline_code ?? intent.error.code,
        }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Payment intent created: ${intent.id} — ${totalCents}c CAD (hold)${discountAmount > 0 ? ` [${discountType} discount -$${discountAmount}]` : ''}`)

    return new Response(
      JSON.stringify({
        success:             true,
        payment_intent_id:   intent.id,
        amount_cents:        totalCents,
        fee_cents:           feeCents,
        discounted_fare:     discountedFare,
        pre_discount_fare:   fare_amount,
        discount_amount:     discountAmount,
        discount_type:       discountType,
        discount_code_id:    discountCodeId,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})