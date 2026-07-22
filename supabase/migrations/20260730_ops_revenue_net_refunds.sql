-- Net voluntary refunds out of reported platform-fee revenue.
--
-- ops_revenue reports the platform fee Vellon earned per company/month/method,
-- but it summed the fee for every completed ride and never looked at refunds —
-- so a refunded card ride still booked its full fee as revenue even though
-- Vellon's realized take was lower (or negative). This adds a `refund_total`
-- column = Vellon's realized LOSS from refunds on those rides, so the caller can
-- show net revenue.
--
-- Realized loss per ride = (refunded_amount_cents - transfer_reversed_cents)/100:
-- the refund left Vellon's balance; whatever was clawed back from the driver/
-- company transfer returned to it; the difference is what Vellon ate. Verified
-- across the cases:
--   • full driver_fault refund  -> reversed = transfer, loss = fee + Stripe fee
--                                  => net fee = -Stripe fee (Vellon out only that)
--   • Vellon-absorb refund       -> reversed = 0, loss = full refund
--   • partial driver_fault       -> reversed = refund, loss = 0 (fee kept)
--   • reversal not yet done/failed-> reversed = 0, counts the full loss until it
--                                    lands (matches actual cash state; corrects
--                                    itself once the webhook reverses)
--
-- Refunds are card-only, so this only ever moves the 'card' rows; cash rows have
-- null refund columns -> 0. Bucketed by the ride's completion month (like the
-- rest of this RPC), so a refund adjusts the month the ride belongs to, not the
-- month it was issued. Everything else about ops_revenue is unchanged from
-- 20260719_ride_fee_percent_snapshot.sql (still sums off the frozen per-ride
-- platform_fee_percent_at_completion; fee_percent stays a gross blended display
-- rate, deliberately NOT net of refunds — it's "the rate charged," not a yield).

-- Adding the refund_total OUT column changes the function's return type, which
-- CREATE OR REPLACE can't do — drop it first.
drop function if exists public.ops_revenue(timestamptz, timestamptz);

create function public.ops_revenue(
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
  fee_total      numeric,
  refund_total   numeric
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
    coalesce(sum(r.fare_final * r.platform_fee_percent_at_completion / 100.0), 0) as fee_total,
    coalesce(sum(
      (coalesce(r.refunded_amount_cents, 0) - coalesce(r.transfer_reversed_cents, 0)) / 100.0
    ), 0)                                     as refund_total
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
