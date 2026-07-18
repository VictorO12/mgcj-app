-- Add a real completion timestamp, immutable once set.
--
-- Background: ops_revenue and the vellon-ops cash-invoice generator both
-- bucketed by rides.updated_at as a stand-in for "when did this ride
-- complete" — but updated_at resets on EVERY update to the row, for any
-- reason. A one-off data-consistency UPDATE on ~30-40 unrelated rides
-- (backfilling null driver_id/passenger_id on 2026-06-27) silently moved
-- those rides' apparent completion month forward, which would misattribute
-- real invoice/revenue totals if left alone. completed_at is set exactly
-- once, on the transition into 'completed', and frozen after — no future
-- write to the row (bulk cleanup, RLS testing, anything) can move it again.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;

CREATE OR REPLACE FUNCTION set_ride_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL THEN
    -- Already set — freeze it regardless of what else this UPDATE touches.
    NEW.completed_at := OLD.completed_at;
  ELSIF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ride_completed_at ON rides;
CREATE TRIGGER trg_ride_completed_at
  BEFORE UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION set_ride_completed_at();

-- Backfill existing completed rides. updated_at is the best available proxy
-- for historical rows — known to be wrong for the specific rides caught by
-- the 2026-06-27 cleanup (their true completion time isn't recoverable), but
-- correct for everything else and a strict improvement over leaving it null.
UPDATE rides
SET completed_at = updated_at
WHERE status = 'completed'
  AND completed_at IS NULL;
