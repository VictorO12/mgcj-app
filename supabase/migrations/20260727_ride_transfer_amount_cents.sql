-- The exact amount (in cents) owed to the settlement destination for a card
-- ride, snapshotted by capture-payment at capture time:
--   transfer_amount_cents = captured_total - vellon_fee - stripe_processing_fee
--
-- Why a snapshot and not a computation: rides that couldn't be transferred at
-- capture (platform_invoiced / transfer_failed / retransfer_failed) get paid out
-- later by the sweep, potentially weeks after. If the sweep re-derived the fee
-- from companies.platform_fee_percent, a rate change between capture and sweep
-- would retroactively resize an old ride's payout — the same bug class already
-- fixed by rides.completed_at and rides.platform_fee_percent_at_completion.
-- The sweep sends this number verbatim and does no fee math at all.
--
-- Null means Stripe's real processing fee could not be read off the charge's
-- balance_transaction at capture time (the branch that writes 'transfer_failed').
-- The sweep re-fetches the by-then-settled balance_transaction for those.
--
-- Set only by capture-payment / the sweep, both service-role. No new grants
-- needed: rides is already exposed via the Data API.

alter table rides
  add column if not exists transfer_amount_cents integer null;

comment on column rides.transfer_amount_cents is
  'Cents owed to the settlement destination, frozen at capture (total - vellon fee - stripe fee). Paid verbatim by sweep-held-transfers; never recomputed.';
