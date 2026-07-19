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

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // ── Verify the caller is a driver, and belongs to a driver_direct company ──
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('role, name, phone, email, company_id')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'driver') {
      return new Response(JSON.stringify({ error: 'Forbidden — drivers only' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: company } = await serviceClient
      .from('companies')
      .select('payout_model')
      .eq('id', profile.company_id)
      .single()

    // Connect onboarding is a driver_direct concept — a company_settles
    // driver has nothing to onboard into, so bail clearly rather than
    // silently creating an unused Stripe account.
    if (company?.payout_model !== 'driver_direct') {
      return new Response(JSON.stringify({ error: 'Direct payouts are not enabled for your company' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Fetch (or create) the driver's Connect account ──────────
    const { data: driver } = await serviceClient
      .from('drivers')
      .select('id, stripe_connect_account_id, connect_status')
      .eq('id', user.id)
      .single()

    if (!driver) {
      return new Response(JSON.stringify({ error: 'Driver record not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let accountId = driver.stripe_connect_account_id

    if (!accountId) {
      // Express account, Canada-only for now (Annapolis Valley launch market).
      // On individual identity by default — drivers are sole proprietors, not
      // registered businesses, in the common case.
      const accountBody: Record<string, string> = {
        type:                                     'express',
        country:                                  'CA',
        business_type:                            'individual',
        'capabilities[card_payments][requested]':  'true',
        'capabilities[transfers][requested]':      'true',
        'metadata[supabase_user_id]':              user.id,
        'metadata[company_id]':                    profile.company_id ?? '',
        // driver_direct fares are captured to the platform balance first, then
        // transferred to this account (see capture-payment) — the charge itself
        // never touches the driver, so a dispute lands on Vellon's balance, not
        // theirs. Delaying this account's own payout to its real bank is a
        // PASSIVE buffer only — it widens the window during which the driver's
        // share hasn't left Stripe entirely yet, in case a dispute needs the
        // Transfer reversed. Nothing currently listens for
        // `charge.dispute.created` and reverses the Transfer automatically
        // (stripe-webhook only handles payment_intent.*/charge.refunded) — that
        // handler is a real follow-up, not built yet. Until it exists, this
        // delay only buys time for a MANUAL reversal, not an automatic one. Set
        // once at account creation; not applied to company_settles accounts.
        'settings[payouts][schedule][interval]':   'daily',
        'settings[payouts][schedule][delay_days]': '7',
      }
      // Omit entirely rather than sending '' — Stripe treats an empty string
      // as an invalid email format, not "no email provided". Most drivers
      // won't have profiles.email set (it's passenger-receipt-oriented, per
      // the known stale-type note), so this is the common case, not an edge
      // case — Stripe's own onboarding form just collects it if missing.
      if (profile.email) {
        accountBody.email = profile.email
      }

      const account = await stripePost('/accounts', accountBody)

      if (account.error) {
        console.error('Stripe Connect account creation error:', account.error)
        return new Response(JSON.stringify({ error: account.error.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      accountId = account.id

      await serviceClient
        .from('drivers')
        .update({
          stripe_connect_account_id: accountId,
          connect_status:            'pending',
        })
        .eq('id', user.id)

      console.log(`Created Connect account for driver ${user.id}: ${accountId}`)
    }

    // ── Create a fresh onboarding link ───────────────────────────
    // Account Links are single-use and short-lived (a few minutes), so a new
    // one is generated on every call rather than cached — safe to call this
    // function repeatedly for a driver who abandoned onboarding partway.
    //
    // NOTE: Stripe rejects custom URL schemes here (`mgcjapp://...` fails
    // Account Links' own URL validation with "not a valid URL") — return_url/
    // refresh_url must be real https URLs. Both point at a bare route
    // (mgcj-dashboard's vercel.json `redirects` entry for
    // /stripe-connect-return) that issues a genuine HTTP 307 redirect to
    // mgcjapp://stripe-connect-return. This matters: a first attempt used a
    // static page whose own client-side JS (`location.replace`) tried to
    // forward to the custom scheme, but that navigation silently never fired
    // inside the ASWebAuthenticationSession-hosted browser (confirmed in
    // testing 2026-07-19 — neither the automatic redirect nor a manual link
    // tap on that page did anything, even though the same custom scheme
    // opened fine from outside the session, e.g. Safari's address bar). A
    // real server-level redirect (Location header) is caught by
    // ASWebAuthenticationSession before any page content loads, which is the
    // standard/documented mechanism (matches on the URL scheme of the
    // redirect target) — don't go back to a client-JS bridge page for this.
    // The client opens the Stripe URL via WebBrowser.openAuthSessionAsync
    // with this same custom-scheme return URL, so it detects the redirect
    // and auto-closes the in-app browser. We still re-check the real account
    // status via check-connect-status regardless of how the session closed —
    // per Stripe's own guidance, the return_url redirect firing (or not)
    // never means onboarding actually completed.
    const accountLink = await stripePost('/account_links', {
      account:     accountId,
      refresh_url: 'https://vellon-dispatch.vercel.app/stripe-connect-return',
      return_url:  'https://vellon-dispatch.vercel.app/stripe-connect-return',
      type:        'account_onboarding',
    })

    if (accountLink.error) {
      console.error('Stripe account link error:', accountLink.error)
      return new Response(JSON.stringify({ error: accountLink.error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({
        success: true,
        url:     accountLink.url,
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
