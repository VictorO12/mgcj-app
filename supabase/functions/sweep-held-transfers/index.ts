import { createClient } from 'jsr:@supabase/supabase-js@2'

// ── sweep-held-transfers (cron, hourly) ───────────────────────────────────
//
// Pays out card rides whose money is sitting on Vellon's platform balance
// because no usable Connect destination existed at capture time. The common
// case is a driver (or company) who hadn't finished Connect onboarding when
// the ride completed and finished it later — this sweeps those rides out
// automatically instead of leaving them for a manual payout.
//
// Deliberate design choices, each with a failure it prevents:
//
//  * NEVER does fee math off a live setting. It sends the frozen
//    rides.transfer_amount_cents snapshotted by capture-payment. Only when
//    that's null (Stripe's fee was unreadable at capture) does it recompute,
//    and then off the FROZEN platform_fee_percent_at_completion — never
//    companies.platform_fee_percent, which may have changed since. Same bug
//    class as the completed_at and fee-snapshot fixes.
//
//  * Asks STRIPE whether this ride was already transferred, not our own DB.
//    A transfer that succeeded at Stripe while our write failed is exactly
//    the case that would double-pay, and our DB by definition has no record
//    of it. transfer_group='ride_<id>' makes that queryable.
//
//  * Live-checks the destination account against the Accounts API rather
//    than trusting drivers.connect_status / companies.stripe_onboarded.
//    Those are set when someone returns from the onboarding flow, so they
//    lag reality for anyone who onboarded without coming back through the
//    app — precisely the population this sweep exists to catch.
//
//  * Plain balance transfer, no source_transaction. The funds are already on
//    the platform balance (that IS what platform_invoiced means), and tying
//    a transfer to a weeks-old settled charge is a constraint with no
//    upside here. Reversal linkage is preserved via stripe_transfer_id.
//
//  * Pays a ride whose dispute Vellon WON, and only that. Winning returns the
//    fare, so the driver is still owed their share — but charge.disputed stays
//    true on Stripe forever, so it can't be used as a skip on its own. The DB
//    query admits won disputes via rides.dispute_won_at (keeping lost/open ones
//    out of an order-by-oldest, limit-50 queue they'd otherwise clog), and the
//    live check below re-resolves every dispute on the charge before sending.
//
//  * Does NOT write settlement_resolved_at. That column is dispatch's manual
//    "I handled this" marker. A swept ride leaves the dashboard's
//    needs-attention list by virtue of its settlement_route changing to a
//    success value (see fetchNeedsAttention in AnalyticsPage.tsx, which
//    filters route ∈ actionable AND resolved_at IS NULL).

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!
const STRIPE_API        = 'https://api.stripe.com/v1'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// Cap per run so one bad batch can't burn the function's wall clock.
const MAX_RIDES_PER_RUN = 50

// Routes this sweep will act on. Deliberately excludes the two
// dispute-adjacent states:
//   'reversal_failed'   — money needs to come BACK from a driver; a transfer
//                         would push it the wrong way entirely.
//   'retransfer_failed' — the original transfer still EXISTS but was reversed,
//                         so the "has this ride been transferred?" guard below
//                         reads as yes and would wrongly skip it. Paying these
//                         correctly means reasoning about amount_reversed on a
//                         disputed charge; that stays manual for now.
const SWEEPABLE_ROUTES = ['platform_invoiced', 'transfer_failed']

async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
  })
  return res.json()
}

async function stripePost(path: string, body: Record<string, string>, idempotencyKey?: string) {
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

// "Can this account receive a platform transfer right now."
//
// The ONLY capability that gates a platform→connected-account transfer is
// `transfers`. Deliberately NOT charges_enabled && payouts_enabled:
//   * payouts_enabled governs money leaving Stripe for the account's own BANK
//     — downstream of, and irrelevant to, the transfer landing in their Stripe
//     balance. An account pending e.g. proof_of_liveness has payouts_enabled
//     false while happily receiving transfers (verified in sandbox 2026-07-20:
//     nine successful transfers to an account in exactly that state).
//   * charges_enabled governs the account accepting charges as a merchant,
//     which has nothing to do with this at all.
// Using the stricter bar here made the sweep skip every account with any
// pending payout requirement — returning a clean, wrong "nothing to do."
//
// check-connect-status keeps the stricter payouts_enabled bar ON PURPOSE:
// it drives the driver-facing "finish your setup" UI, where you do want full
// onboarding before showing "complete." Different operation, different bar —
// don't unify them.
//
// Note this is intentionally MORE permissive than capture-payment's own
// destination check, which reads the cached drivers.connect_status flag.
// A driver can be transfers-active without ever having been marked complete
// (they never came back through the app). Catching exactly that case is why
// this sweep live-checks Stripe instead of trusting the flag.
async function accountIsLive(accountId: string): Promise<boolean> {
  const account = await stripeGet(`/accounts/${accountId}`)
  if (account.error) {
    console.error(`[sweep] account ${accountId} fetch error:`, account.error.message)
    return false
  }
  return account.capabilities?.transfers === 'active'
}

Deno.serve(async () => {
  const started = Date.now()
  const summary = { examined: 0, swept: 0, reconciled: 0, skipped: 0, failed: 0 }

  const { data: rides, error } = await supabase
    .from('rides')
    .select(
      'id, company_id, driver_id, settlement_route, transfer_amount_cents, ' +
      'platform_fee_percent_at_completion, stripe_payment_intent_id, ' +
      'stripe_dispute_id, completed_at',
    )
    .in('settlement_route', SWEEPABLE_ROUTES)
    .is('settlement_resolved_at', null)   // dispatch already paid this by hand
    // Never move money out on a disputed ride — UNLESS Vellon won it, in which
    // case the fare came back and the driver is still owed their share. Lost
    // and still-open disputes stay excluded here rather than being filtered
    // later, deliberately: this query is order(completed_at asc).limit(50), so
    // permanently-unpayable lost-dispute rides would otherwise pile up at the
    // head of the queue and starve legitimately payable ones.
    // dispute_won_at is only a ticket INTO the query — step 2 below still
    // live-verifies against Stripe before any money moves.
    .or('stripe_dispute_id.is.null,dispute_won_at.not.is.null')
    .eq('payment_status', 'succeeded')
    .not('stripe_payment_intent_id', 'is', null)
    .order('completed_at', { ascending: true })
    .limit(MAX_RIDES_PER_RUN)

  if (error) {
    console.error('[sweep] fetch error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  if (!rides || rides.length === 0) {
    return new Response(JSON.stringify({ ...summary, ms: Date.now() - started }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Hour-bucketed so a retry an hour later is a genuinely NEW request to
  // Stripe. A static per-ride key would be actively harmful here: Stripe
  // caches ERRORS under an idempotency key for 24h, so a transient failure
  // on one tick would be replayed as the same failure on every subsequent
  // tick for a day — turning "retry hourly" into "retry once daily" and
  // stalling a legitimate payout long after the account went live. The real
  // dedup is the transfer_group query below, not this key.
  const hourBucket = new Date().toISOString().slice(0, 13) // YYYY-MM-DDTHH

  for (const ride of rides) {
    summary.examined++

    try {
      // ── 1. Has Stripe already transferred for this ride? ──────────────
      // Asked of Stripe, not of us: the dangerous case is a transfer that
      // succeeded there while our DB write failed, which leaves our row
      // looking exactly like one that was never paid.
      const existing = await stripeGet(`/transfers?transfer_group=ride_${ride.id}&limit=10`)
      if (existing.error) {
        console.error(`[sweep] ride ${ride.id}: transfer lookup failed —`, existing.error.message)
        summary.failed++
        continue
      }
      if (Array.isArray(existing.data) && existing.data.length > 0) {
        // Reconcile rather than resend. Route is inferred from where the
        // money actually went, not from what we assumed it should have.
        const t = existing.data[0]
        const { data: co } = await supabase
          .from('companies').select('stripe_account_id').eq('id', ride.company_id).maybeSingle()
        const route = co?.stripe_account_id && t.destination === co.stripe_account_id
          ? 'company_transfer'
          : 'driver_transfer'

        await supabase.from('rides').update({
          settlement_route:      route,
          stripe_transfer_id:    t.id,
          transfer_amount_cents: ride.transfer_amount_cents ?? t.amount,
        }).eq('id', ride.id)

        console.log(`[sweep] ride ${ride.id}: transfer ${t.id} already existed — reconciled as ${route}`)
        summary.reconciled++
        continue
      }

      // ── 2. Is the money still ours to send? ───────────────────────────
      // A refunded charge has no dispute id, so the disputed-ride filter
      // above doesn't catch it. Paying out a refunded ride is a straight
      // loss — the passenger already has the money back.
      const intent = await stripeGet(`/payment_intents/${ride.stripe_payment_intent_id}`)
      if (intent.error || intent.status !== 'succeeded') {
        console.log(`[sweep] ride ${ride.id}: PI not in a payable state (${intent.error?.message ?? intent.status}) — skipping`)
        summary.skipped++
        continue
      }

      const chargeId = intent.latest_charge
      const charge = chargeId ? await stripeGet(`/charges/${chargeId}?expand[]=balance_transaction`) : null
      if (charge?.refunded || (charge?.amount_refunded ?? 0) > 0) {
        console.log(`[sweep] ride ${ride.id}: charge ${chargeId} refunded — skipping`)
        summary.skipped++
        continue
      }

      // charge.disputed can NOT be used as a skip on its own: Stripe leaves it
      // true forever once a charge has been disputed, including after a win
      // (verified on ch_3TvT1E... — succeeded/disputed:true/refunded:false long
      // after the dispute closed 'won'). Treating it as terminal is what made
      // won disputes permanently unpayable. So resolve the actual outcome, and
      // only pay when EVERY dispute on the charge is won — a charge can carry
      // more than one, and a single open or lost dispute means the money isn't
      // ours to send.
      //
      // Read live rather than trusting rides.dispute_won_at: that column is
      // written by a webhook, and this is the last gate before money leaves.
      if (charge?.disputed) {
        const disputes = await stripeGet(`/disputes?charge=${chargeId}&limit=100`)
        const rows = disputes?.data
        if (disputes?.error || !Array.isArray(rows) || rows.length === 0) {
          // Flagged disputed but the outcome is unreadable — fail closed.
          console.log(`[sweep] ride ${ride.id}: charge ${chargeId} disputed but disputes unreadable (${disputes?.error?.message ?? 'no rows'}) — skipping`)
          summary.skipped++
          continue
        }
        const unresolved = rows.filter((d: { status: string }) => d.status !== 'won')
        if (unresolved.length > 0) {
          console.log(`[sweep] ride ${ride.id}: charge ${chargeId} has ${unresolved.length} dispute(s) not won (${unresolved.map((d: { status: string }) => d.status).join(', ')}) — skipping`)
          summary.skipped++
          continue
        }
        console.log(`[sweep] ride ${ride.id}: charge ${chargeId} disputed but all ${rows.length} dispute(s) won — payable`)
      }

      // ── 3. Where does it go? ──────────────────────────────────────────
      const { data: company } = await supabase
        .from('companies')
        .select('stripe_account_id, stripe_onboarded, payout_model')
        .eq('id', ride.company_id)
        .maybeSingle()

      let destination: { id: string; route: string } | null = null

      if (company?.payout_model === 'driver_direct' && ride.driver_id) {
        const { data: driver } = await supabase
          .from('drivers')
          .select('stripe_connect_account_id, connect_status')
          .eq('id', ride.driver_id)
          .maybeSingle()

        if (driver?.stripe_connect_account_id && await accountIsLive(driver.stripe_connect_account_id)) {
          destination = { id: driver.stripe_connect_account_id, route: 'driver_transfer' }
        }
      }

      if (!destination && company?.stripe_account_id && await accountIsLive(company.stripe_account_id)) {
        destination = { id: company.stripe_account_id, route: 'company_transfer' }
      }

      // Deliberately does NOT write back drivers.connect_status /
      // companies.stripe_onboarded. Those flags mean "finished onboarding"
      // on the STRICTER payouts_enabled bar (see accountIsLive above), and
      // this function only established the weaker transfers-active fact.
      // Stamping 'complete' from here would tell a driver their setup is done
      // while Stripe still has outstanding requirements blocking their bank
      // payouts — a worse lie than a stale flag.

      if (!destination) {
        // Still nobody to pay. Leave the row exactly as it is so it stays on
        // dispatch's needs-attention list, and try again next hour.
        summary.skipped++
        continue
      }

      // ── 4. How much? ──────────────────────────────────────────────────
      let amountCents = ride.transfer_amount_cents

      if (amountCents === null || amountCents === undefined) {
        // capture-payment couldn't read Stripe's fee at the time. Recompute
        // now that the balance_transaction has settled — using the FROZEN
        // per-ride rate, never the company's current one.
        const stripeFee = charge?.balance_transaction?.fee
        const totalCents = charge?.amount
        const frozenPct = ride.platform_fee_percent_at_completion

        if (typeof stripeFee !== 'number' || typeof totalCents !== 'number' || frozenPct === null) {
          console.error(`[sweep] ride ${ride.id}: cannot determine amount (fee=${stripeFee}, total=${totalCents}, pct=${frozenPct}) — skipping`)
          summary.skipped++
          continue
        }
        amountCents = totalCents - Math.round(totalCents * (frozenPct / 100)) - stripeFee
      }

      if (amountCents <= 0) {
        console.log(`[sweep] ride ${ride.id}: nothing owed after fees (${amountCents}) — skipping`)
        summary.skipped++
        continue
      }

      // ── 5. Send it ────────────────────────────────────────────────────
      const transfer = await stripePost('/transfers', {
        amount:              String(amountCents),
        currency:            'cad',
        destination:         destination.id,
        transfer_group:      `ride_${ride.id}`,
        'metadata[ride_id]': ride.id,
        'metadata[source]':  'sweep-held-transfers',
      }, `sweep-${ride.id}-${hourBucket}`)

      if (transfer.error) {
        // Leave settlement_route untouched — the ride stays on the
        // needs-attention list and gets another attempt next hour.
        console.error(`[sweep] ride ${ride.id}: transfer failed —`, transfer.error.message)
        summary.failed++
        continue
      }

      await supabase.from('rides').update({
        settlement_route:      destination.route,
        stripe_transfer_id:    transfer.id,
        transfer_amount_cents: amountCents,
      }).eq('id', ride.id)

      console.log(`[sweep] ride ${ride.id}: $${(amountCents / 100).toFixed(2)} → ${destination.route} (${transfer.id})`)
      summary.swept++

    } catch (err) {
      console.error(`[sweep] ride ${ride.id}: unexpected error`, err)
      summary.failed++
    }
  }

  console.log(`[sweep] ${JSON.stringify(summary)} in ${Date.now() - started}ms`)

  return new Response(JSON.stringify({ ...summary, ms: Date.now() - started }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
