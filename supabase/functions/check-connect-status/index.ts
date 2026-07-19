import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
  })
  return res.json()
}

// Re-checks a driver's Connect account against Stripe and syncs
// drivers.connect_status. Called after the app returns from the hosted
// onboarding flow — per Stripe's own guidance, the account_link return_url
// firing does NOT mean onboarding actually completed, so the real status
// has to come from the Accounts API, not the redirect itself.
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

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: driver } = await serviceClient
      .from('drivers')
      .select('id, stripe_connect_account_id, connect_status')
      .eq('id', user.id)
      .single()

    if (!driver?.stripe_connect_account_id) {
      return new Response(JSON.stringify({ error: 'No Connect account on file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const account = await stripeGet(`/accounts/${driver.stripe_connect_account_id}`)
    if (account.error) {
      console.error('Stripe account fetch error:', account.error)
      return new Response(JSON.stringify({ error: account.error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Same bar used elsewhere for "can this account actually receive
    // transfers" — charges_enabled + payouts_enabled, not just
    // details_submitted (a driver can submit the form but still be pending
    // Stripe's own verification).
    const newStatus =
      account.charges_enabled && account.payouts_enabled ? 'complete' : 'pending'

    if (newStatus !== driver.connect_status) {
      await serviceClient
        .from('drivers')
        .update({ connect_status: newStatus })
        .eq('id', user.id)
    }

    return new Response(
      JSON.stringify({ success: true, connect_status: newStatus }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
