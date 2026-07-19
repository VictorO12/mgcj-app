-- Splits the previously-overloaded 'reversal_failed' value: it was being
-- written for two opposite situations that need opposite manual remediation
-- (claw money BACK from a driver vs. SEND money owed TO a driver), with no
-- way for whoever works the manual queue to tell which one they're looking
-- at. 'reversal_failed' now means only "couldn't reverse an outstanding
-- transfer on dispute.created" (driver still holds money Vellon needs back).
-- 'retransfer_failed' means "couldn't re-send a driver's share after Vellon
-- won a dispute" (driver is owed money that hasn't reached them).

alter table rides drop constraint if exists rides_settlement_route_check;
alter table rides add constraint rides_settlement_route_check
  check (settlement_route in (
    'driver_transfer', 'company_transfer', 'platform_invoiced', 'transfer_failed',
    'transfer_reversed', 'reversal_failed', 'retransfer_failed'
  ));
