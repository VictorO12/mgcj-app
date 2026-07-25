-- Settlements: cash lane for the dashboard rollup (driver_direct framing).
--
-- The Settlements tab has only ever shown CARD rides, because every number on it
-- traces a Stripe transfer (settlement_route, transfer_amount_cents). Cash rides
-- have no PaymentIntent, no capture, no transfer -- the driver collects the fare
-- at the door and keeps it -- so settlement_route/transfer_amount_cents are null
-- on every cash ride. Folding them into the card RPCs would dump them all into
-- the 'unsettled'/'problem' bucket, which is both wrong and alarming.
--
-- Cash is a different kind of number, so it gets its own RPC. For a driver_direct
-- company there are exactly two facts about a cash ride:
--   * the fare is already 100% with the driver (nothing to route/hold/fail), and
--   * Vellon's fee on it accrues as the company's monthly-invoice liability
--     (cash can't be skimmed at the transaction, so it's billed monthly at the
--     same rate as card -- the cash/card parity is deliberate).
--
-- So this returns gross cash fares, the ride count, and the accruing Vellon fee.
-- "Drivers keep" (= fares - fee) is derived client-side. The dashboard renders
-- this strip ONLY for driver_direct companies: the "drivers keep" net framing is
-- only true when the driver owns the fare. company_settles cash is a different
-- story (the company owns the fare revenue) and gets its own framing later; this
-- RPC stays model-agnostic so it can be reused for that.
--
-- Same freezing discipline as company_settlement_rollup: the fee is summed off
-- the FROZEN platform_fee_percent_at_completion (stamped once on the transition
-- into 'completed', never the live companies.platform_fee_percent), and fares off
-- fare_final (never the client-editable fare_estimate) -- so a later rate change
-- can't retroactively resize an already-completed period. Both columns are
-- guaranteed non-null on any app-completed ride (the completion trigger stamps
-- them alongside fare_final), but we coalesce defensively so a stray seeded row
-- can't null out the whole aggregate.
--
-- SECURITY INVOKER (default), scoped to get_my_company_id() (itself SECURITY
-- DEFINER) -- an admin/dispatcher only ever sees their own company's cash rides.

create or replace function company_cash_settlement(p_from timestamptz, p_to timestamptz)
returns table (
  cash_rides    integer,
  cash_fares    numeric,   -- gross: what passengers paid the driver in cash
  cash_fee_owed numeric    -- Vellon's fee accruing on that cash, billed monthly
)
language sql
stable
as $$
  select
    count(*)::int                                                   as cash_rides,
    coalesce(sum(r.fare_final), 0)                                  as cash_fares,
    coalesce(
      sum(r.fare_final * coalesce(r.platform_fee_percent_at_completion, 0) / 100.0),
      0
    )                                                               as cash_fee_owed
  from rides r
  where r.company_id = get_my_company_id()
    and r.payment_method = 'cash'
    and r.status = 'completed'
    and r.fare_final is not null   -- match ops_revenue exactly, so the fee shown
                                   -- here reconciles cent-for-cent with the
                                   -- monthly invoice vellon-ops generates
    and r.completed_at >= p_from
    and r.completed_at <  p_to;
$$;

grant execute on function public.company_cash_settlement(timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
