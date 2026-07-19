-- Driver-side settlement totals, computed server-side over the driver's
-- FULL ride history (not the capped last-50 fetch RideHistoryScreen uses
-- for the list itself). The client-side "Net to you" total was silently
-- wrong for any driver with more than ~50 rides -- it only summed whatever
-- happened to be in the paginated fetch. This RPC sums correctly regardless
-- of ride count.
--
-- Deliberately invoker-rights (no SECURITY DEFINER) -- the existing RLS
-- policy on rides already lets a driver select their own rows, so this
-- doesn't need elevated privilege; auth.uid() inside still resolves to the
-- calling driver either way.
--
-- Vellon's fee and net are computed from the FROZEN per-ride rate
-- (platform_fee_percent_at_completion), never the company's live setting --
-- same reasoning as ops_revenue -- so a rate change never retroactively
-- reshapes a driver's past totals.

create or replace function driver_settlement_totals()
returns table (
  total_fares      numeric,
  total_vellon_fee numeric,
  total_stripe_fee numeric,
  total_net        numeric,
  rides_count      integer
)
language sql
stable
as $$
  select
    coalesce(sum(r.fare_final), 0) as total_fares,
    coalesce(sum(r.fare_final * r.platform_fee_percent_at_completion / 100.0), 0) as total_vellon_fee,
    coalesce(sum(coalesce(r.stripe_fee, 0)), 0) as total_stripe_fee,
    coalesce(sum(
      r.fare_final
      - r.fare_final * r.platform_fee_percent_at_completion / 100.0
      - coalesce(r.stripe_fee, 0)
    ), 0) as total_net,
    count(*)::int as rides_count
  from rides r
  where r.driver_id = auth.uid()
    and r.status = 'completed'
    and r.fare_final is not null
    and r.platform_fee_percent_at_completion is not null;
$$;

grant execute on function public.driver_settlement_totals() to authenticated;
