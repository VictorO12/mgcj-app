-- Dispatch visibility for rides auto-assignment deliberately did NOT place.
--
-- assign-ride has always given up silently: no drivers, everyone declined, and
-- now (the reason this column exists) every candidate is confirmed for a
-- scheduled pickup they'd miss by taking this trip. Dispatch had no signal for
-- any of those — the ride just sits `pending` until expire-pending-rides
-- cancels it at 5 minutes. That was tolerable when the only causes were "nobody
-- is online"; it is not tolerable now that the dispatcher is being asked to
-- make a judgement call the auto-dispatcher refuses to make.
--
-- Read by mgcj-dashboard on pending/offered rides. Cleared on assignment.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS assignment_hold_reason  text NULL,
  ADD COLUMN IF NOT EXISTS assignment_hold_details jsonb NULL;

COMMENT ON COLUMN rides.assignment_hold_reason IS
  'Why auto-assignment placed nobody: no_drivers | all_declined | driver_committed. NULL once assigned.';
COMMENT ON COLUMN rides.assignment_hold_details IS
  'Context for the dashboard. For driver_committed: {at, drivers:[{driver_id, ride_id, scheduled_at}]}. Driver IDs, never names — the dashboard resolves names off the live roster, and a stored name goes stale.';

-- No GRANTs needed: rides predates the Oct-30-2026 Data API grant rule and is
-- already exposed. New COLUMNS inherit the table's privileges.
