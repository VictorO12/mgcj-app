-- Tracks disputes against a ride's charge, and extends settlement_route to
-- cover what happens to an already-sent Transfer when a dispute lands.
--
-- 'transfer_reversed' — a driver_transfer/company_transfer was successfully
--                        reversed (funds pulled back from the destination
--                        account's balance) after a dispute was opened
-- 'reversal_failed'   — the reversal call errored (commonly: the destination
--                        account's balance no longer covers it, e.g. already
--                        paid out) — needs manual recovery

alter table rides
  add column if not exists stripe_dispute_id text null;

alter table rides drop constraint if exists rides_settlement_route_check;
alter table rides add constraint rides_settlement_route_check
  check (settlement_route in (
    'driver_transfer', 'company_transfer', 'platform_invoiced', 'transfer_failed',
    'transfer_reversed', 'reversal_failed'
  ));
