-- Platform-wide settlement reconciliation for the Vellon Ops console
-- (Revenue → Settlement reconciliation section).
--
-- Answers "where did each company's card money actually go this period?" —
-- rolled up by company × settlement_route. This is the CROSS-COMPANY,
-- service-role counterpart to company_settlement_rollup() (20260726), which is
-- scoped to a single company via get_my_company_id() for the dispatch
-- dashboard. Vellon Ops needs every company at once, so it can't reuse that one.
--
-- Money figure is SUM(transfer_amount_cents) — the driver/company share that was
-- (or should have been) transferred out, snapshotted at capture and never
-- re-derived (a rate change must not retroactively resize an old ride's payout;
-- same reasoning as sweep-held-transfers and the completed_at/fee-snapshot
-- fixes). A null snapshot (Stripe's fee was unreadable at capture) counts as 0 —
-- understates rather than inventing a number, matching getStrandedSettlements.
-- fares_total (fare_final) is carried alongside purely for context.
--
-- settlement_route is free text (the CHECK enum was dropped once dispute/refund
-- states were added), so the GROUP BY is dynamic — any future route value shows
-- up on its own rather than needing this function changed. null routes (a
-- completed card ride that matched no settlement branch — e.g. a sub-fee tiny
-- fare) surface as 'unsettled'.
--
-- Time axis is the frozen rides.completed_at, bucketed by the caller's UTC
-- range bounds — same contract as ops_revenue. Card only: settlement_route only
-- ever applies to card fares (cash is settled by monthly invoice, no transfer).
--
-- SECURITY DEFINER owned by postgres; execute granted only to service_role
-- (the Vellon Ops server). Mirrors ops_revenue().

create or replace function public.ops_settlement_reconciliation(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  company_id       uuid,
  company_name     text,
  settlement_route text,
  ride_count       bigint,
  transfer_total   numeric,  -- dollars: sum of transfer_amount_cents / 100
  fares_total      numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.company_id,
    c.name                                                        as company_name,
    coalesce(r.settlement_route, 'unsettled')                     as settlement_route,
    count(*)                                                      as ride_count,
    coalesce(sum(r.transfer_amount_cents), 0) / 100.0             as transfer_total,
    coalesce(sum(r.fare_final), 0)                               as fares_total
  from rides r
  join companies c on c.id = r.company_id
  where r.status = 'completed'
    and r.payment_method = 'card'
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by r.company_id, c.name, coalesce(r.settlement_route, 'unsettled');
$$;

revoke all on function public.ops_settlement_reconciliation(timestamptz, timestamptz) from public;
grant execute on function public.ops_settlement_reconciliation(timestamptz, timestamptz) to service_role;
