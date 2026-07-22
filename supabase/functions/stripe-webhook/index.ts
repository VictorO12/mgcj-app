import { createClient } from 'jsr:@supabase/supabase-js@2'

const STRIPE_SECRET_KEY      = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_WEBHOOK_SECRET  = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const STRIPE_API             = 'https://api.stripe.com/v1'

// ── Stripe helpers (the dispute + refund handlers call back to Stripe to
// reverse/re-send transfers — the plain status events just write to the DB) ──
async function stripePost(path: string, body: Record<string, string> = {}, idempotencyKey?: string) {
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
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
  })
  return res.json()
}

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
        const charge = event.data.object

        // Charges do NOT inherit their PaymentIntent's metadata, so the ride_id
        // (set only on the PI) is never on charge.metadata — look the ride up by
        // payment_intent, the same way the dispute handlers do. (The old
        // charge.metadata?.ride_id lookup was always empty: this handler had been
        // a silent no-op — even the payment_status write never fired.)
        const paymentIntentId: string | undefined =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id

        if (!paymentIntentId) {
          console.warn('charge.refunded — no payment_intent on charge object')
          break
        }

        const { data: ride } = await serviceClient
          .from('rides')
          .select('id, settlement_route, stripe_transfer_id, transfer_amount_cents, refund_absorbed_by')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle()

        if (!ride) {
          console.warn(`charge.refunded — no ride found for payment_intent ${paymentIntentId}`)
          break
        }

        // The refund's REASON decides who absorbs it. vellon-ops stamps it as
        // Stripe refund metadata at refund time, so it reaches us here without
        // racing vellon-ops's own DB write. A refund issued straight in the
        // Stripe dashboard (out-of-band) carries no metadata — absorbedBy is then
        // null and we default to the driver-first clawback (protects Vellon, same
        // as the dispute handler, and recoverable if it was meant as goodwill).
        //
        // Fetch the latest refund explicitly instead of reading charge.refunds
        // from the event: that list is expansion-only on current Stripe API
        // versions and isn't reliably in the webhook payload, and the metadata
        // channel is load-bearing here.
        const refundList = await stripeGet(`/refunds?charge=${charge.id}&limit=1`)

        // If we couldn't actually read the refund, bail and let Stripe retry the
        // webhook — do NOT fall through. The metadata is the reason channel, and
        // guessing here could wrongly claw a Vellon-absorb (goodwill) refund back
        // from the driver just because the fetch blipped. A missing `data` array
        // means the call failed (a real but empty result is still an array).
        if (!Array.isArray(refundList?.data) || refundList.data.length === 0) {
          console.error(`charge.refunded — could not read refund for charge ${charge.id} (will retry):`, refundList?.error ?? 'no refund returned')
          return new Response(JSON.stringify({ error: 'refund_fetch_failed' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }

        const latestRefund = refundList.data[0]
        const refundMeta   = latestRefund?.metadata ?? {}
        const absorbedBy: string | null =
          refundMeta.absorbed_by ?? ride.refund_absorbed_by ?? null

        // Cumulative figures straight off the charge (authoritative — covers any
        // earlier partial refunds too).
        const refundedCents: number = charge.amount_refunded ?? 0
        const fullyRefunded: boolean = charge.refunded === true

        // Record the refund on the ride (display/reporting). Only downgrade
        // payment_status to 'refunded' on a FULL refund — a partial leaves it
        // 'succeeded' so it isn't mistaken for a failed/unpaid ride elsewhere.
        const refundUpdate: Record<string, unknown> = {
          refunded_amount_cents: refundedCents,
          refunded_at:           new Date().toISOString(),
          stripe_refund_id:      latestRefund?.id ?? null,
        }
        if (refundMeta.reason)      refundUpdate.refund_reason = refundMeta.reason
        if (refundMeta.absorbed_by) refundUpdate.refund_absorbed_by = refundMeta.absorbed_by
        if (fullyRefunded)          refundUpdate.payment_status = 'refunded'

        await serviceClient.from('rides').update(refundUpdate).eq('id', ride.id)

        // Vellon absorbs (platform_mistake / goodwill) — no clawback, the driver
        // keeps their money. Route stays as it was; the refund is captured by the
        // columns above.
        if (absorbedBy === 'vellon') {
          console.log(`Ride ${ride.id}: refund of ${refundedCents}¢ absorbed by Vellon — no transfer reversal`)
          break
        }

        const hasOutstandingTransfer =
          !!ride.stripe_transfer_id &&
          ride.transfer_amount_cents != null &&
          (ride.settlement_route === 'driver_transfer' || ride.settlement_route === 'company_transfer')

        // Out-of-band refund (issued straight in the Stripe dashboard, no reason
        // metadata): we don't know who's at fault, so we do NOT move a driver's
        // money on a guess. Flag it as 'refund_review' for Victor to reconcile in
        // vellon-ops (where it surfaces in the stranded-settlements list); the
        // refund is still recorded above. If nothing was transferred out there's
        // nothing to reconcile.
        if (absorbedBy === null) {
          if (hasOutstandingTransfer) {
            await serviceClient
              .from('rides')
              .update({ settlement_route: 'refund_review' })
              .eq('id', ride.id)
            console.log(`Ride ${ride.id}: out-of-band refund of ${refundedCents}¢ — flagged refund_review (no metadata, transfer outstanding)`)
          } else {
            console.log(`Ride ${ride.id}: out-of-band refund of ${refundedCents}¢ recorded, no outstanding transfer (route: ${ride.settlement_route})`)
          }
          break
        }

        // driver_fault: claw the refund back from the transfer, DRIVER-FIRST —
        // recover up to the driver/company's whole share, Vellon supplements only
        // the overflow (the refund itself already left Vellon's balance, so
        // anything we don't reverse is what Vellon eats).
        if (!hasOutstandingTransfer) {
          console.log(`Ride ${ride.id}: refund of ${refundedCents}¢ recorded, no outstanding transfer to reverse (route: ${ride.settlement_route})`)
          break
        }

        // Desired cumulative reversal, driver-first: never more than the driver
        // was actually sent. Reverse only the DELTA vs what's already been
        // reversed on the transfer (read live from Stripe) so repeated partial
        // refunds — and a webhook that fires on every refund — never double-claw.
        const desiredReversed = Math.min(refundedCents, ride.transfer_amount_cents)

        const transfer = await stripeGet(`/transfers/${ride.stripe_transfer_id}`)
        const alreadyReversed: number = transfer?.amount_reversed ?? 0
        const delta = desiredReversed - alreadyReversed

        if (delta <= 0) {
          console.log(`Ride ${ride.id}: refund clawback already satisfied (reversed ${alreadyReversed}¢ of ${desiredReversed}¢ target) — nothing to do`)
          break
        }

        // Idempotency-Key derived from the ride + cumulative target so a webhook
        // retry reaches Stripe as the SAME reversal, not a second one.
        const reversal = await stripePost(
          `/transfers/${ride.stripe_transfer_id}/reversals`,
          { amount: delta.toString() },
          `refund-rev-${ride.id}-${desiredReversed}`,
        )

        if (reversal.error) {
          // Common cause: the destination account's balance no longer covers it
          // (already paid out to their bank) — reuse the actionable reversal_failed
          // route so it lands in dispatch/Vellon's "collect this back" queue.
          console.error(`Ride ${ride.id}: failed to reverse ${delta}¢ of transfer ${ride.stripe_transfer_id} for refund:`, reversal.error)
          await serviceClient
            .from('rides')
            .update({ settlement_route: 'reversal_failed' })
            .eq('id', ride.id)
        } else {
          console.log(`Ride ${ride.id}: reversed ${delta}¢ of transfer ${ride.stripe_transfer_id} for refund (cumulative ${desiredReversed}¢)`)
          await serviceClient
            .from('rides')
            .update({ settlement_route: 'refund_reversed', transfer_reversed_cents: desiredReversed })
            .eq('id', ride.id)
        }
        break
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object
        const paymentIntentId: string | undefined =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id

        if (!paymentIntentId) {
          console.warn('charge.dispute.created — no payment_intent on dispute object')
          break
        }

        const { data: ride } = await serviceClient
          .from('rides')
          .select('id, stripe_transfer_id, settlement_route')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle()

        if (!ride) {
          console.warn(`charge.dispute.created — no ride found for payment_intent ${paymentIntentId}`)
          break
        }

        await serviceClient
          .from('rides')
          .update({ stripe_dispute_id: dispute.id })
          .eq('id', ride.id)

        // Only a ride whose settlement actually left the platform balance
        // (sent to a driver or company Connect account) needs reversing —
        // platform_invoiced never left, transfer_failed never sent anything.
        const hasOutstandingTransfer =
          !!ride.stripe_transfer_id &&
          (ride.settlement_route === 'driver_transfer' || ride.settlement_route === 'company_transfer')

        if (!hasOutstandingTransfer) {
          console.log(`Ride ${ride.id}: dispute ${dispute.id} recorded, no outstanding transfer to reverse (route: ${ride.settlement_route})`)
          break
        }

        // Idempotency-Key derived from the dispute id so a webhook retry
        // reaches Stripe as the SAME reversal attempt, not a second one.
        const reversal = await stripePost(
          `/transfers/${ride.stripe_transfer_id}/reversals`,
          {},
          `reversal-${dispute.id}`,
        )

        if (reversal.error) {
          // Common cause: the destination account's balance no longer covers
          // it (already paid out to their bank) — needs manual recovery.
          console.error(`Ride ${ride.id}: failed to reverse transfer ${ride.stripe_transfer_id} for dispute ${dispute.id}:`, reversal.error)
          await serviceClient
            .from('rides')
            .update({ settlement_route: 'reversal_failed' })
            .eq('id', ride.id)
        } else {
          console.log(`Ride ${ride.id}: reversed transfer ${ride.stripe_transfer_id} for dispute ${dispute.id}`)
          await serviceClient
            .from('rides')
            .update({ settlement_route: 'transfer_reversed' })
            .eq('id', ride.id)
        }
        break
      }

      case 'charge.dispute.closed': {
        const dispute = event.data.object
        const paymentIntentId: string | undefined =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id
        const chargeId: string | undefined =
          typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id

        if (!paymentIntentId) {
          console.warn('charge.dispute.closed — no payment_intent on dispute object')
          break
        }

        const { data: ride } = await serviceClient
          .from('rides')
          .select('id, driver_id, company_id, fare_final, platform_fee_percent_at_completion, stripe_fee, settlement_route')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle()

        if (!ride) {
          console.warn(`charge.dispute.closed — no ride found for payment_intent ${paymentIntentId}`)
          break
        }

        if (dispute.status !== 'won') {
          // 'lost' (or any other terminal status) — Vellon keeps absorbing
          // the reversal, nothing to re-send. Just log for the record.
          console.log(`Ride ${ride.id}: dispute ${dispute.id} closed as '${dispute.status}' — no action needed`)
          break
        }

        // Stamp the win BEFORE the route branch below, so it lands for every
        // route, not just the one this handler re-transfers for. This is what
        // re-admits a still-held payout ('platform_invoiced'/'transfer_failed')
        // to sweep-held-transfers, which is otherwise blocked forever by its
        // `stripe_dispute_id IS NULL` filter — the driver did the ride, and
        // winning means Vellon kept the fare and genuinely owes them their
        // share. Deliberately does NOT clear stripe_dispute_id: that's the
        // audit trail and vellon-ops joins its dispute_costs rows on it.
        await serviceClient
          .from('rides')
          .update({ dispute_won_at: new Date().toISOString() })
          .eq('id', ride.id)

        if (ride.settlement_route !== 'transfer_reversed') {
          // No transfer of ours to undo. Either none ever went out (the payout
          // was still held — now handed to the sweep by the stamp above), or
          // it's already been re-sent.
          console.log(`Ride ${ride.id}: dispute ${dispute.id} won, settlement_route '${ride.settlement_route}' — nothing to re-send here; marked dispute_won_at for the sweep`)
          break
        }

        if (!chargeId || ride.fare_final == null || ride.platform_fee_percent_at_completion == null || ride.stripe_fee == null) {
          console.error(`Ride ${ride.id}: dispute ${dispute.id} won, but missing data to recompute the re-transfer amount — needs manual payout`)
          break
        }

        // Re-resolve the destination the same way capture-payment originally
        // did — we don't store which one the reversed transfer went to, and
        // re-deriving it (rather than caching it) means this naturally picks
        // up a driver who finished Connect onboarding in the meantime.
        const { data: company } = await serviceClient
          .from('companies')
          .select('stripe_account_id, stripe_onboarded, payout_model')
          .eq('id', ride.company_id)
          .single()

        const isDriverDirect = company?.payout_model === 'driver_direct'

        let driver: { stripe_connect_account_id: string | null; connect_status: string | null } | null = null
        if (isDriverDirect && ride.driver_id) {
          const { data } = await serviceClient
            .from('drivers')
            .select('stripe_connect_account_id, connect_status')
            .eq('id', ride.driver_id)
            .maybeSingle()
          driver = data
        }

        const destination =
          isDriverDirect && driver?.connect_status === 'complete' && driver?.stripe_connect_account_id
            ? { id: driver.stripe_connect_account_id, route: 'driver_transfer' }
            : company?.stripe_onboarded && company?.stripe_account_id
              ? { id: company.stripe_account_id, route: 'company_transfer' }
              : null

        if (!destination) {
          console.error(`Ride ${ride.id}: dispute ${dispute.id} won, but no usable Connect account to re-send the transfer to — needs manual payout`)
          break
        }

        // Same real-numbers-only math capture-payment uses — never re-estimate
        // the fee, both platform_fee_percent_at_completion and stripe_fee were
        // already frozen/real values from the original capture.
        const totalCents    = Math.round(ride.fare_final * 100)
        const feeCents       = Math.round(totalCents * (ride.platform_fee_percent_at_completion / 100))
        const stripeFeeCents = Math.round(ride.stripe_fee * 100)
        const transferCents  = totalCents - feeCents - stripeFeeCents

        if (transferCents <= 0) {
          console.warn(`Ride ${ride.id}: dispute ${dispute.id} won, but computed re-transfer amount is <= 0 — skipping`)
          break
        }

        // Idempotency-Key derived from the dispute id so a webhook retry
        // reaches Stripe as the SAME re-transfer attempt, not a second one.
        const transfer = await stripePost('/transfers', {
          amount:               transferCents.toString(),
          currency:             'cad',
          destination:          destination.id,
          source_transaction:   chargeId,
          'metadata[ride_id]':  ride.id,
          'metadata[dispute_won_retransfer]': 'true',
        }, `retransfer-${dispute.id}`)

        if (transfer.error) {
          console.error(`Ride ${ride.id}: failed to re-send transfer after won dispute ${dispute.id}:`, transfer.error)
          await serviceClient
            .from('rides')
            .update({ settlement_route: 'retransfer_failed' })
            .eq('id', ride.id)
        } else {
          console.log(`Ride ${ride.id}: re-sent transfer ${transfer.id} after won dispute ${dispute.id}`)
          await serviceClient
            .from('rides')
            .update({ settlement_route: destination.route, stripe_transfer_id: transfer.id })
            .eq('id', ride.id)
        }
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