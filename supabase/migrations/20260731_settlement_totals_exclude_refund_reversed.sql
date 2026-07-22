-- Extend "Net to you" to also exclude refund clawbacks, not just disputes.
--
-- 20260727_settlement_totals_exclude_reversed.sql taught driver_settlement_totals
-- to drop 'transfer_reversed' (dispute) rides out of total_net. The voluntary
-- refund flow (20260729/20260730) added a second way a driver's payout can be
-- pulled back after the fact: a driver_fault refund reverses their transfer and
-- sets settlement_route = 'refund_reversed'. Without this, a refunded ride still
-- inflated the driver's lifetime net — the same "shows money the driver no
-- longer has" bug that migration fixed, via a different route.
--
-- Difference from the dispute case: a dispute is always FULL, so the whole
-- ride's net is reversed. A refund can be PARTIAL, so only the amount actually
-- clawed back (transfer_reversed_cents) leaves the driver — they keep the rest.
-- So refund_reversed subtracts transfer_reversed_cents, NOT the whole net.
--
-- 'refund_review' (an out-of-band refund flagged for manual handling) is left
-- INSIDE net on purpose, same reasoning as 'reversal_failed': no clawback has
-- actually happened yet, so the driver still holds the money.
--
-- Signature unchanged (same OUT columns), so CREATE OR REPLACE is fine — no
-- drop, grants preserved. Still invoker-rights over the RLS self-select, still
-- off the frozen platform_fee_percent_at_completion.

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

    -- Net = each ride's full net minus whatever was pulled back from it.
    coalesce(sum(
      ( r.fare_final
        - r.fare_final * r.platform_fee_percent_at_completion / 100.0
        - coalesce(r.stripe_fee, 0) )
      - case
          -- Dispute reversed the whole transfer.
          when r.settlement_route = 'transfer_reversed' then
            r.fare_final
            - r.fare_final * r.platform_fee_percent_at_completion / 100.0
            - coalesce(r.stripe_fee, 0)
          -- Refund clawed back a slice (possibly partial).
          when r.settlement_route = 'refund_reversed' then
            coalesce(r.transfer_reversed_cents, 0) / 100.0
          else 0
        end
    ), 0) as total_net,

    -- ...and the pulled-back amount is reported separately so the strip stays
    -- checkable: fares − vellon fee − stripe fee − reversed = net.
    coalesce(sum(
      case
        when r.settlement_route = 'transfer_reversed' then
          r.fare_final
          - r.fare_final * r.platform_fee_percent_at_completion / 100.0
          - coalesce(r.stripe_fee, 0)
        when r.settlement_route = 'refund_reversed' then
          coalesce(r.transfer_reversed_cents, 0) / 100.0
        else 0
      end
    ), 0) as total_reversed,

    count(*)::int as rides_count
  from rides r
  where r.driver_id = auth.uid()
    and r.status = 'completed'
    and r.fare_final is not null
    and r.platform_fee_percent_at_completion is not null;
$$;

grant execute on function public.driver_settlement_totals() to authenticated;
