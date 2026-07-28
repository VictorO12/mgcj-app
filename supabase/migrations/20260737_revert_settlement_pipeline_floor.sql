-- Revert the pre-pipeline completed_at floor added by 20260735/20260736.
--
-- Those two migrations hid the 94 pre-settlement-pipeline card rides from the
-- settlement views. We changed strategy: the 44 that carry a real captured
-- PaymentIntent are being settled for real (stamped platform_invoiced and run
-- through sweep-held-transfers → driver_transfer / company_transfer), and the
-- 50 that were never charged are being deleted. Once settled, the 44 must be
-- VISIBLE in the settlement views so they reconcile with revenue — but they all
-- completed before the 2026-07-19 12:00 floor, so the floor would keep hiding
-- them. So the floor has to come out.
--
-- Restores each of the three functions to its pre-floor body (the completed_at
-- lower bound goes back to a plain `>= p_from`). Bodies are the exact live
-- definitions captured before the floor was applied.

-- ── Vellon Ops: cross-company reconciliation ──────────────────────────────
create or replace function public.ops_settlement_reconciliation(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  company_id       uuid,
  company_name     text,
  settlement_route text,
  ride_count       bigint,
  transfer_total   numeric,
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

-- ── Dashboard: company-scoped rollup (4-column net version) ────────────────
create or replace function public.company_settlement_rollup(p_from timestamptz, p_to timestamptz)
returns table(settlement_route text, rides_count integer, total_fares numeric, net_total numeric)
language sql
stable
as $function$
  select
    coalesce(r.settlement_route, 'unsettled')                    as settlement_route,
    count(*)::int                                                as rides_count,
    coalesce(sum(r.fare_final), 0)                               as total_fares,
    coalesce(sum(coalesce(r.transfer_amount_cents, 0)), 0) / 100.0 as net_total
  from rides r
  where r.company_id = get_my_company_id()
    and r.payment_method = 'card'
    and r.status = 'completed'
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by r.settlement_route;
$function$;

grant execute on function public.company_settlement_rollup(timestamptz, timestamptz) to authenticated;

-- ── Dashboard: company-scoped daily series ────────────────────────────────
create or replace function public.company_settlement_daily(p_from timestamptz, p_to timestamptz)
returns table(day date, bucket text, gross numeric, net numeric)
language sql
stable
as $function$
  select
    (r.completed_at at time zone 'America/Halifax')::date as day,
    case
      when r.settlement_route in ('driver_transfer', 'company_transfer') then 'paid'
      when r.settlement_route = 'platform_invoiced'                      then 'held'
      else 'problem'
    end                                                          as bucket,
    coalesce(sum(r.fare_final), 0)                               as gross,
    coalesce(sum(coalesce(r.transfer_amount_cents, 0)), 0) / 100.0 as net
  from rides r
  where r.company_id = get_my_company_id()
    and r.payment_method = 'card'
    and r.status = 'completed'
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by 1, 2;
$function$;

grant execute on function public.company_settlement_daily(timestamptz, timestamptz) to authenticated;
