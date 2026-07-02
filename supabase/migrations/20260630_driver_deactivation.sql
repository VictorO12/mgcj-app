-- Driver deactivation / soft-delete support
-- is_active: account-level gate (false = suspended by dispatch)
-- deactivation_pending: deactivate after current ride completes
-- deleted_at: already existed on profiles; used for soft-delete here

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivation_pending boolean NOT NULL DEFAULT false;

-- Grants for PostgREST access
GRANT SELECT (is_active, deactivation_pending) ON profiles TO anon, authenticated;
GRANT UPDATE (is_active, deactivation_pending) ON profiles TO authenticated;

-- Trigger: when a ride transitions to completed/cancelled, flip any
-- driver whose deactivation was deferred until end-of-ride
CREATE OR REPLACE FUNCTION handle_driver_deactivation_on_ride_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled') AND NEW.driver_id IS NOT NULL THEN
    UPDATE profiles
    SET is_active = false, deactivation_pending = false
    WHERE id = NEW.driver_id
      AND deactivation_pending = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_deactivation_on_ride_complete ON rides;
CREATE TRIGGER trg_driver_deactivation_on_ride_complete
AFTER UPDATE ON rides
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'cancelled'))
EXECUTE FUNCTION handle_driver_deactivation_on_ride_complete();
