-- Settlements: card fee breakdown for the company_settles dashboard view.
--
-- For a company_settles company, "where did the card money route" is a trivial
-- question -- it all lands in the company's own Stripe account -- so the
-- route-based hero/donut/table degenerate to a single value. The useful question
-- for them is the FARE BREAKDOWN: of what passengers paid, how much did the
-- company keep, and what did Vellon and Stripe take? This RPC returns exactly
-- that, over the SETTLED card rides in a period.
--
-- The reconciliation identity gross = net + Vellon fee + Stripe fee must hold to
-- the cent, so Vellon's fee is DERIVED, not recomputed from fare * pct:
--
--   * gross  = sum(fare_final)                       -- captured total (dollars)
--   * stripe = sum(stripe_fee)                        -- real Stripe fee (dollars,
--                                                        frozen at capture)
--   * net    = sum(transfer_amount_cents) / 100       -- what actually transferred
--   * vellon = gross - stripe - net                   -- the exact remainder
--
-- capture-payment computes transfer_amount_cents = captured - feeCents - stripeFee
-- (all in cents, feeCents = round(captured * pct/100)). So per ride
-- fare_final = feeCents/100 + stripe_fee + transfer_amount_cents/100, i.e.
-- gross - stripe - net == feeCents/100 exactly -- the real ROUNDED Vellon cut
-- that was actually withheld, not a re-multiplied nominal that would drift a
-- sub-cent per ride. There is no persisted Vellon-fee column (fee_cents lives
-- only in capture-payment's response JSON), so deriving it is also the only way
-- to get the true figure.
--
-- Scoped to the settled routes (driver_transfer / company_transfer) so every
-- ride in scope is guaranteed to have non-null stripe_fee AND
-- transfer_amount_cents (an unreadable Stripe fee routes to transfer_failed, not
-- a settled route) -- which is what makes the identity exact. Held / failed /
-- reversed rides are exceptions surfaced in the dashboard's Needs-attention
-- section, deliberately excluded here so the breakdown describes only money that
-- actually moved.
--
-- SECURITY INVOKER (default), scoped to get_my_company_id() (SECURITY DEFINER).
-- Card + completed + frozen completed_at, same discipline as the sibling
-- settlement RPCs. Model-agnostic (no payout_model filter) -- the dashboard
-- chooses when to show it; the numbers are valid for any company.

create or replace function company_settlement_fee_breakdown(p_from timestamptz, p_to timestamptz)
returns table (
  paid_rides  integer,
  gross_fares numeric,   -- what passengers were charged
  vellon_fee  numeric,   -- Vellon's cut (derived remainder -> exact)
  stripe_fee  numeric,   -- Stripe's processing fee
  net_total   numeric    -- what actually landed in the company's account
)
language sql
stable
as $$
  select
    count(*)::int                                                  as paid_rides,
    coalesce(sum(r.fare_final), 0)                                 as gross_fares,
    coalesce(sum(r.fare_final), 0)
      - coalesce(sum(r.stripe_fee), 0)
      - coalesce(sum(r.transfer_amount_cents), 0) / 100.0          as vellon_fee,
    coalesce(sum(r.stripe_fee), 0)                                 as stripe_fee,
    coalesce(sum(r.transfer_amount_cents), 0) / 100.0              as net_total
  from rides r
  where r.company_id = get_my_company_id()
    and r.payment_method = 'card'
    and r.status = 'completed'
    and r.settlement_route in ('driver_transfer', 'company_transfer')
    and r.fare_final is not null
    -- Make the reconciliation invariant LOCAL, not cross-path. A settled route
    -- is normally guaranteed non-null transfer_amount_cents/stripe_fee (capture
    -- routes an unreadable Stripe fee to transfer_failed instead) -- but that
    -- route is also stamped by sweep-held-transfers and the dispute-won
    -- re-transfer. If any of those ever left transfer_amount_cents null, the
    -- coalesce(...,0) below would silently attribute that ride's whole fare to
    -- Vellon fee (net understated, our cut overstated) while the donut/waterfall
    -- still reconcile perfectly -- an invisible misattribution. Dropping such
    -- rows here makes that impossible regardless of which path set the route,
    -- and is consistent with "describes only money that actually moved".
    and r.transfer_amount_cents is not null
    and r.stripe_fee is not null
    and r.completed_at >= p_from
    and r.completed_at <  p_to;
$$;

grant execute on function public.company_settlement_fee_breakdown(timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
