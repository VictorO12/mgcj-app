-- FIX: the settlement_route CHECK constraint was never updated for the two
-- voluntary-refund states, so the stripe-webhook charge.refunded handler's
-- writes were silently rejected.
--
-- 20260729_ride_refund_fields.sql introduced 'refund_reversed' (driver_fault
-- clawback succeeded) and 'refund_review' (out-of-band refund, needs manual
-- handling) and its comment says "no enum — settlement_route is free text" — but
-- that was never true: the CHECK from 20260725 (rides_settlement_route_check)
-- was still in force and only allowed values through 'retransfer_failed'. So the
-- webhook would reverse the transfer at Stripe (that part works — verified:
-- amount_reversed lands correctly), then UPDATE settlement_route='refund_reversed'
-- would violate the CHECK, the handler's un-error-checked .update() swallowed it,
-- and the ride kept its old route with transfer_reversed_cents NULL. Net effect: a
-- driver_fault refund's clawback happened on Stripe's side but the platform's
-- books showed it as un-clawed / Vellon-absorbed.
--
-- Confirmed by the asymmetry in live data: 'transfer_reversed' (the dispute path,
-- which IS in the 20260725 list) persists fine; 'refund_reversed'/'refund_review'
-- never appeared on any row despite multiple driver_fault and out-of-band refunds.
--
-- This re-adds the constraint with the full current set. Keeping it enumerated
-- (rather than dropping to true free text) preserves the guardrail — the real
-- lesson here is that a comment claiming "free text" doesn't drop a constraint;
-- the constraint must actually be maintained. The stripe-webhook is separately
-- being hardened to error-check these writes so a future mismatch can't fail
-- silently again.

alter table rides drop constraint if exists rides_settlement_route_check;
alter table rides add constraint rides_settlement_route_check
  check (settlement_route in (
    'driver_transfer', 'company_transfer', 'platform_invoiced', 'transfer_failed',
    'transfer_reversed', 'reversal_failed', 'retransfer_failed',
    'refund_reversed', 'refund_review'
  ));
