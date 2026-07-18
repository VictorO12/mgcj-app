-- Freeze the platform fee rate onto each ride at completion, and make
-- ops_revenue sum off that frozen rate instead of the company's live rate.
--
-- Background: ops_revenue previously joined companies.platform_fee_percent
-- live, for every ride, every time it's queried. That means changing a
-- company's fee rate today would retroactively recompute revenue/invoice
-- totals for every past month still un-invoiced (draft invoices are
-- regenerated from live data; only sent/paid invoices had their fee_percent
-- snapshotted). A rate change should only affect rides completed after the
-- change — past rides must keep the rate that was actually in effect when
-- they completed. Same "freeze what mattered at the time" pattern as
-- completed_at (20260718_ride_completed_at.sql) and the fare-field freeze
-- (20260713_freeze_ride_fare_fields.sql).
--
-- Stamped by the same trigger/transition as completed_at (into 'completed'),
-- not a separate trigger, since it's the same moment and the same freeze
-- semantics.
--
-- Backfill note: existing completed rides get stamped with the company's
-- CURRENT platform_fee_percent. Checked against vellon-ops's audit_log
-- (2026-07-19) — neither M&G Cab nor C&J Taxi has ever had a real fee-rate
-- change recorded (the only audit hits are unrelated scratch companies at 5%,
-- and a same-value no-op save on C&J). Both real companies have been flat at
-- their current rate since creation, so this backfill is exact, not a
-- known-imperfect proxy.

alter table rides
  add column if not exists platform_fee_percent_at_completion numeric(5,2) null;

-- Backfill existing completed rides per the note above. Must run BEFORE the
-- trigger function below is replaced: the new function's freeze branch fires
-- on ANY update to an already-completed row (old.completed_at is not null),
-- and would clobber this backfill's value right back to null/old in the same
-- statement if it were already installed.
update rides
set platform_fee_percent_at_completion = c.platform_fee_percent
from companies c
where c.id = rides.company_id
  and rides.status = 'completed'
  and rides.platform_fee_percent_at_completion is null;

create or replace function set_ride_completed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.completed_at is not null then
    -- Already set — freeze both completion fields regardless of what else
    -- this update touches.
    new.completed_at := old.completed_at;
    new.platform_fee_percent_at_completion := old.platform_fee_percent_at_completion;
  elsif new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at := now();
    select platform_fee_percent into new.platform_fee_percent_at_completion
    from companies where id = new.company_id;
  end if;
  return new;
end;
$$;

-- Trigger already exists (trg_ride_completed_at) and fires the function
-- above — no change needed there, only the function body changed.

-- ── ops_revenue: sum off the frozen per-ride rate ────────────────────
-- fee_percent is now a display-only blended rate (fee_total / fares_total),
-- so it always stays arithmetically consistent with fee_total even when a
-- rate change splits a month's rides across two rates. Group by no longer
-- includes the rate, so a mid-month change still yields one row per
-- company/month/payment_method instead of splitting it.
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
    case when sum(r.fare_final) > 0
      then round(sum(r.fare_final * r.platform_fee_percent_at_completion / 100.0)
                 / sum(r.fare_final) * 100, 2)
      else 0
    end                                       as fee_percent,
    date_trunc('month', r.completed_at at time zone 'UTC')::date as month,
    r.payment_method,
    count(*)                                 as ride_count,
    coalesce(sum(r.fare_final), 0)           as fares_total,
    coalesce(sum(r.fare_final * r.platform_fee_percent_at_completion / 100.0), 0) as fee_total
  from rides r
  join companies c on c.id = r.company_id
  where r.status = 'completed'
    and r.fare_final is not null
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by r.company_id, c.name,
           date_trunc('month', r.completed_at at time zone 'UTC'), r.payment_method;
$$;

revoke all on function public.ops_revenue(timestamptz, timestamptz) from public;
grant execute on function public.ops_revenue(timestamptz, timestamptz) to service_role;
