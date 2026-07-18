-- Revenue aggregation for the Vellon Ops console (Revenue module).
--
-- There is no platform-fee ledger in mgcj — the fee is derived on the fly from
-- each completed ride's fare_final × the company's platform_fee_percent. Doing
-- that SUM/GROUP BY in SQL (rather than pulling raw rides into the Node server)
-- keeps it correct past PostgREST's 1000-row page cap and cheap at any volume.
--
-- Time axis is rides.completed_at (added 20260718_ride_completed_at.sql) — set
-- once on the transition into 'completed' and frozen after, so it can't drift
-- when something unrelated later updates the row. Previously this used
-- updated_at, which resets on every write to the row for any reason; a stray
-- data-consistency UPDATE months after the fact silently reassigned real
-- rides to the wrong revenue/invoice month. Months are bucketed in UTC
-- (explicit `at time zone 'UTC'`) so the result is deterministic regardless
-- of the connection's session timezone; the caller passes UTC month bounds to
-- match. A handful of late-evening-Halifax rides may land in the next UTC month
-- — immaterial for cash-invoice totals, and avoids DST offset math.
--
-- SECURITY DEFINER owned by postgres; execute granted only to service_role
-- (the Vellon Ops server). Mirrors ops_health_system().

create or replace function public.ops_revenue(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  company_id     uuid,
  company_name   text,
  fee_percent    numeric,
  month          date,
  payment_method text,
  ride_count     bigint,
  fares_total    numeric,
  fee_total      numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.company_id,
    c.name                                   as company_name,
    c.platform_fee_percent                   as fee_percent,
    date_trunc('month', r.completed_at at time zone 'UTC')::date as month,
    r.payment_method,
    count(*)                                 as ride_count,
    coalesce(sum(r.fare_final), 0)           as fares_total,
    coalesce(sum(r.fare_final * c.platform_fee_percent / 100.0), 0) as fee_total
  from rides r
  join companies c on c.id = r.company_id
  where r.status = 'completed'
    and r.fare_final is not null
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by r.company_id, c.name, c.platform_fee_percent,
           date_trunc('month', r.completed_at at time zone 'UTC'), r.payment_method;
$$;

revoke all on function public.ops_revenue(timestamptz, timestamptz) from public;
grant execute on function public.ops_revenue(timestamptz, timestamptz) to service_role;
