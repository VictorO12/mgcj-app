import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

// ── Stripe helper ─────────────────────────────────────────────
async function stripeRequest(path: string, body: Record<string, string> = {}, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
  })
  return res.json()
}

async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'GET',
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

    // ── Determine the capture amount from Stripe, not the DB ────
    // The charge is sized off the PaymentIntent's server-set authorized amount,
    // never off ride.fare_final/fare_estimate — both are passenger-writable, and
    // trusting them let a tampered-down fare drive the capture. The hold is
    // always server-sized (create-payment-intent for immediate rides,
    // scheduled-release for scheduled), so the authorized amount is authoritative.
    const intent = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
    if (intent.error) {
      return new Response(JSON.stringify({ error: 'Could not load payment intent' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Only a manual-capture PI awaiting capture can be captured. Bail clearly on
    // already-captured / canceled / never-confirmed intents instead of a bad capture.
    if (intent.status !== 'requires_capture') {
      return new Response(JSON.stringify({
        error: intent.status === 'succeeded'
          ? 'Already captured'
          : `Payment not capturable (status: ${intent.status})`,
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const totalCents: number = intent.amount_capturable ?? intent.amount ?? 0
    if (!totalCents || totalCents <= 0) {
      return new Response(JSON.stringify({ error: 'No capturable amount on this payment' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch company fee percent + payout model to recalculate the Connect split.
    const { data: company } = await serviceClient
      .from('companies')
      .select('platform_fee_percent, stripe_account_id, stripe_onboarded, payout_model')
      .eq('id', ride.company_id)
      .single()

    const isDriverDirect = company?.payout_model === 'driver_direct'
    const feePct         = company?.platform_fee_percent ?? 10
    const feeCents        = Math.round(totalCents * (feePct / 100))

    // driver_direct fetches the driver's Connect status up front — needed to
    // decide the settlement route once the capture succeeds. company_settles
    // has no driver leg to consider (the company is always the candidate).
    let driver: { stripe_connect_account_id: string | null; connect_status: string | null } | null = null
    if (isDriverDirect) {
      const { data } = await serviceClient
        .from('drivers')
        .select('stripe_connect_account_id, connect_status')
        .eq('id', ride.driver_id)
        .maybeSingle()
      driver = data
    }

    // ── Capture the payment intent for the full authorized amount ──
    // Both payout models now capture the FULL amount straight to the platform
    // balance — no transfer_data here, ever. (This used to differ: company_settles
    // set transfer_data[amount] here, fixing the company's cut BEFORE Stripe's
    // real processing fee was known, which meant the fee silently ate into
    // Vellon's leftover share instead of the company's. Fixed 2026-07-21 by
    // moving company_settles onto the same "capture first, transfer the exact
    // remainder after the real fee is known" pattern driver_direct already
    // used — see the settlement block below, now shared by both models.)
    const captureBody: Record<string, string> = {
      amount_to_capture: totalCents.toString(),
    }

    // Idempotency-Key derived from ride_id so a client-side retry (dropped
    // response, remount mid-request) reaches Stripe as the SAME capture
    // attempt instead of a second one racing the first.
    const captured = await stripeRequest(
      `/payment_intents/${ride.stripe_payment_intent_id}/capture`,
      captureBody,
      `capture-${ride_id}`
    )

    if (captured.error) {
      console.error('Stripe capture error:', captured.error)

      // Don't blindly mark 'failed' — this error can be the losing side of a
      // race (two near-simultaneous capture calls both saw requires_capture,
      // the other one's request landed first and actually captured the money).
      // Re-fetch the PI and trust ITS status: if Stripe says the money really
      // was captured, sync 'succeeded' instead of falsely recording 'failed'
      // on a ride that was, in fact, paid.
      const recheck = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
      if (recheck.status === 'succeeded') {
        const recapturedFare = (recheck.amount_received ?? totalCents) / 100
        await serviceClient
          .from('rides')
          .update({
            payment_status: 'succeeded',
            fare_final:     recapturedFare,
            fare_estimate:  recapturedFare,
          })
          .eq('id', ride_id)

        return new Response(
          JSON.stringify({ success: true, amount_cents: recheck.amount_received ?? totalCents }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      // Only record 'failed' on a CONFIRMED terminal failure state. An
      // ambiguous intermediate status (e.g. 'processing', or still
      // 'requires_capture' if this recheck raced ahead of the other request's
      // own write) is not proof the ride failed — writing 'failed' there risks
      // landing after a concurrent request's later 'succeeded' write. Leave
      // payment_status untouched in that case; the client/webhook gets another
      // chance to resolve it.
      const isConfirmedFailure = recheck.status === 'canceled' || recheck.status === 'requires_payment_method'
      if (isConfirmedFailure) {
        await serviceClient
          .from('rides')
          .update({ payment_status: 'failed' })
          .eq('id', ride_id)
      }

      return new Response(JSON.stringify({ error: captured.error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const capturedFare = totalCents / 100
    let settlementRoute: string | null = null
    let stripeTransferId: string | null = null

    // Settlement runs the same way for BOTH payout models now: read the ACTUAL
    // Stripe processing fee off the charge (not an estimate — this charge has
    // no transfer_data/on_behalf_of, so Stripe's fee came out of the platform
    // balance, and it must come out of the transfer amount too or Vellon's cut
    // quietly overpays itself at the recipient's expense), then transfer the
    // exact remainder to whichever destination applies.
    const chargeId = captured.latest_charge
    let stripeFeeCents: number | null = null
    if (chargeId) {
      const charge = await stripeGet(`/charges/${chargeId}?expand[]=balance_transaction`)
      // balance_transaction can still be null immediately post-capture in rare
      // cases — if so, DON'T default the fee to 0. Guessing 0 would transfer
      // Stripe's real fee straight out of Vellon's cut. Fail the transfer for
      // manual retry instead of moving money on an unverified fee.
      stripeFeeCents = typeof charge?.balance_transaction?.fee === 'number'
        ? charge.balance_transaction.fee
        : null
    }

    // driver_direct tries the driver first, then falls back to the company;
    // company_settles only ever has the company as a candidate.
    const destination =
      isDriverDirect && driver?.connect_status === 'complete' && driver?.stripe_connect_account_id
        ? { id: driver.stripe_connect_account_id, route: 'driver_transfer' }
        : company?.stripe_onboarded && company?.stripe_account_id
          ? { id: company.stripe_account_id, route: 'company_transfer' }
          : null

    if (destination && chargeId && stripeFeeCents === null) {
      console.error(`Ride ${ride_id}: could not confirm Stripe's processing fee on charge ${chargeId} — skipping transfer, needs manual retry`)
      settlementRoute = 'transfer_failed'
    } else if (destination && chargeId && stripeFeeCents !== null && (totalCents - feeCents - stripeFeeCents) > 0) {
      const transferCents = totalCents - feeCents - stripeFeeCents
      const transfer = await stripeRequest('/transfers', {
        amount:                  transferCents.toString(),
        currency:                'cad',
        destination:             destination.id,
        source_transaction:      chargeId,
        'metadata[ride_id]':     ride_id,
      }, `transfer-${ride_id}`)

      if (transfer.error) {
        console.error(`Transfer error for ride ${ride_id}:`, transfer.error)
        settlementRoute = 'transfer_failed'
      } else {
        settlementRoute  = destination.route
        stripeTransferId = transfer.id
      }
    } else if (!destination) {
      // Neither a driver (driver_direct) nor the company has a usable Connect
      // account — funds stay on the platform balance, to be invoiced like a
      // cash fare (future settlement/invoicing work).
      settlementRoute = 'platform_invoiced'
    }

    // ── Persist the true charged amount ─────────────────────────
    // Overwrite fare_final AND fare_estimate with what was actually captured so
    // receipts, ride history and revenue analytics match the card charge — even
    // if the stored estimate had been tampered down. Card rides are exempt from
    // the cash_fare_final_range constraint, so this write is safe. (Webhook will
    // also fire payment_intent.succeeded; we update here for a snappy UI.)
    await serviceClient
      .from('rides')
      .update({
        payment_status:     'succeeded',
        fare_final:         capturedFare,
        fare_estimate:      capturedFare,
        settlement_route:   settlementRoute,
        stripe_transfer_id: stripeTransferId,
        stripe_fee:         stripeFeeCents !== null ? stripeFeeCents / 100 : null,
      })
      .eq('id', ride_id)

    console.log(`Ride ${ride_id} captured — $${capturedFare} CAD${settlementRoute ? ` [${settlementRoute}]` : ''}`)

    return new Response(
      JSON.stringify({
        success:           true,
        amount_cents:      totalCents,
        fee_cents:         feeCents,
        settlement_route:  settlementRoute,
        stripe_transfer_id: stripeTransferId,
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
