-- "Net to you" was counting money the driver no longer has.
--
-- driver_settlement_totals summed every completed ride with no regard for
-- settlement_route, so a ride whose Transfer was REVERSED after a dispute
-- (charge.dispute.created pulls the funds back out of the driver's Connect
-- balance) still contributed to their lifetime net. The app showed a total
-- that disagreed with the driver's actual Stripe balance, in the app's
-- favour — the worst direction for a number a driver is paid against.
--
-- Fix keeps the RECORD intact and only narrows the CLAIM:
--   * rides_count / total_fares  — unchanged. The ride was driven and the
--     fare was really collected; erasing it would make a driver's history
--     shrink with no explanation, which reads as a bug or a cheat.
--   * total_net                  — now excludes transfer_reversed rides.
--   * total_reversed (NEW)       — what those rides would have paid, so the
--     loss is shown explicitly rather than silently subtracted.
--
-- So the strip stays arithmetically checkable:
--   fares − vellon fee − stripe fee − reversed = net
--
-- 'reversal_failed' deliberately stays INSIDE total_net: that state means the
-- reversal itself failed, so the driver still holds the money. Excluding it
-- would understate their balance — the opposite error.
--
-- Everything else about the function is unchanged, and unchanged on purpose:
-- still invoker-rights (relies on the existing RLS self-select policy on
-- rides, scoped to auth.uid() internally), and still computes Vellon's cut
-- from the FROZEN per-ride platform_fee_percent_at_completion so a rate
-- change never reshapes a driver's past totals.

-- DROP first: adding total_reversed changes the OUT-parameter row type, and
-- `create or replace` cannot change a function's return signature (42P13).
-- Dropping also drops its grants, so the grant at the bottom is required, not
-- decorative. Run this file as ONE statement batch — between the drop and the
-- create the RPC doesn't exist, and any driver opening ride history in that
-- window gets an error instead of their totals.
drop function if exists driver_settlement_totals();

create or replace function driver_settlement_totals()
returns table (
  total_fares      numeric,
  total_vellon_fee numeric,
  total_stripe_fee numeric,
  total_net        numeric,
  total_reversed   numeric,
  rides_count      integer
)
language sql
stable
as $$
  select
    coalesce(sum(r.fare_final), 0) as total_fares,
    coalesce(sum(r.fare_final * r.platform_fee_percent_at_completion / 100.0), 0) as total_vellon_fee,
    coalesce(sum(coalesce(r.stripe_fee, 0)), 0) as total_stripe_fee,

    -- Net EXCLUDES reversed rides.
    coalesce(sum(
      case when r.settlement_route = 'transfer_reversed' then 0
      else
        r.fare_final
        - r.fare_final * r.platform_fee_percent_at_completion / 100.0
        - coalesce(r.stripe_fee, 0)
      end
    ), 0) as total_net,

    -- ...and is reported separately here. Note the null-safe comparison is
    -- unnecessary in the CASE above but the intent matters: settlement_route
    -- is NULL for company_settles rides predating the 2026-07-21 conversion,
    -- and those must keep counting as normal earnings.
    coalesce(sum(
      case when r.settlement_route = 'transfer_reversed' then
        r.fare_final
        - r.fare_final * r.platform_fee_percent_at_completion / 100.0
        - coalesce(r.stripe_fee, 0)
      else 0 end
    ), 0) as total_reversed,

    count(*)::int as rides_count
  from rides r
  where r.driver_id = auth.uid()
    and r.status = 'completed'
    and r.fare_final is not null
    and r.platform_fee_percent_at_completion is not null;
$$;

grant execute on function public.driver_settlement_totals() to authenticated;
