-- Settlements: net basis + daily buckets for the dashboard rollup redesign.
--
-- Two changes, both driven by the Settlements tab gaining a Net | Gross toggle
-- (net default) and a daily settlement-flow chart:
--
--   1. company_settlement_rollup now also returns net_total alongside the gross
--      total_fares. NET is what actually left as a transfer to the driver /
--      company after BOTH Vellon's platform fee and Stripe's processing fee --
--      i.e. rides.transfer_amount_cents, the frozen per-ride snapshot written at
--      capture time (capture-payment). We sum that snapshot, never re-derive a
--      fee, so a later platform_fee_percent change can't retroactively resize an
--      old period (same rule as completed_at / the fee snapshot fixes).
--      Gross stays sum(fare_final) so the two lenses reconcile: gross - net = the
--      Vellon + Stripe fees withheld.
--
--   2. company_settlement_daily buckets the same card rides by local calendar day
--      and a coarse settlement bucket ('paid' / 'held' / 'problem') so the chart
--      can stack paid-to-drivers vs held per day, in either basis. Day is bucketed
--      in America/Halifax (the platform's pinned zone) so "today" lines up with
--      how dispatch reads the clock, not UTC.
--
-- Both are SECURITY INVOKER (default) and scoped to get_my_company_id(), which is
-- itself SECURITY DEFINER -- an admin/dispatcher only ever sees their own
-- company's rides, same as the existing rollup. Card + completed only; a null
-- settlement_route folds to 'unsettled' (rollup) / 'problem' (daily) rather than
-- vanishing, so a completed card ride with no transfer recorded still shows.

-- Adding net_total changes the RETURNS TABLE shape, and Postgres won't let
-- CREATE OR REPLACE change a function's return type -- it errors with "cannot
-- change return type of existing function". Drop the old 3-column version first.
drop function if exists company_settlement_rollup(timestamptz, timestamptz);

create or replace function company_settlement_rollup(p_from timestamptz, p_to timestamptz)
returns table (
  settlement_route text,
  rides_count      integer,
  total_fares      numeric,   -- gross: what passengers were charged
  net_total        numeric    -- net: what actually transferred out, after fees
)
language sql
stable
as $$
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
$$;

grant execute on function public.company_settlement_rollup(timestamptz, timestamptz) to authenticated;

create or replace function company_settlement_daily(p_from timestamptz, p_to timestamptz)
returns table (
  day    date,
  bucket text,      -- 'paid' | 'held' | 'problem'
  gross  numeric,
  net    numeric
)
language sql
stable
as $$
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
$$;

grant execute on function public.company_settlement_daily(timestamptz, timestamptz) to authenticated;

-- The rollup's return shape changed (new net_total column). Nudge PostgREST to
-- reload its schema cache, or supabase-js may keep serving the old 3-column
-- result and the dashboard would never see net_total.
notify pgrst, 'reload schema';
