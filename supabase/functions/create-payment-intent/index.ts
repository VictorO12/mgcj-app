import { createClient } from 'jsr:@supabase/supabase-js@2'
import { computeAuthoritativeFare } from '../_shared/fare.ts'

const STRIPE_SECRET_KEY  = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API         = 'https://api.stripe.com/v1'

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

    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, discount_code } = await req.json()

    if (
      pickup_lat == null || pickup_lng == null ||
      dropoff_lat == null || dropoff_lng == null
    ) {
      return new Response(JSON.stringify({ error: 'Missing pickup/dropoff coordinates' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch passenger Stripe customer ID + company (for discount eligibility and pricing)
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

    // Compute the authoritative fare + discount server-side (single source of
    // truth, shared with scheduled-release). Never trust a client-supplied fare.
    const {
      fare:           fare_amount,
      discountedFare,
      discountAmount,
      discountType,
      discountCodeId,
    } = await computeAuthoritativeFare(serviceClient, {
      userId:     user.id,
      companyId:  passenger.company_id,
      pickupLat:  pickup_lat,  pickupLng:  pickup_lng,
      dropoffLat: dropoff_lat, dropoffLng: dropoff_lng,
      discountCode: discount_code ?? null,
    })
    if (!fare_amount || fare_amount <= 0) {
      return new Response(JSON.stringify({ error: 'Could not compute fare — check coordinates.' }), {
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

    // Use platform fee default — actual fee % recalculated against the
    // company at capture time in capture-payment, off the discounted fare.
    const platformFeePercent = 10.0
    const totalCents         = Math.round(discountedFare * 100)
    const feeCents           = Math.round(totalCents * (platformFeePercent / 100))

    // If the company is fully Stripe-onboarded, route the charge to its Connect
    // account. transfer_data[destination] MUST be set here at creation, or
    // capture-payment's transfer_data[amount] gets rejected by Stripe. Gated on
    // stripe_onboarded (matching capture-payment / scheduled-release) so an
    // account id stamped during onboarding, before the account can receive
    // transfers, doesn't start routing prematurely.
    const { data: company } = passenger.company_id
      ? await serviceClient
          .from('companies')
          .select('stripe_account_id, stripe_onboarded')
          .eq('id', passenger.company_id)
          .maybeSingle()
      : { data: null }

    // Create PaymentIntent with manual capture (hold only)
    const intentBody: Record<string, string> = {
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
    }
    if (company?.stripe_onboarded && company?.stripe_account_id) {
      intentBody['transfer_data[destination]'] = company.stripe_account_id
    }
    const intent = await stripePost('/payment_intents', intentBody)

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