-- append_declined_by previously used a bare array_append, so a driver
-- declining the same ride twice (assign -> decline -> reassign -> decline
-- again) would show up twice in declined_by. Dedupe on append so any UI
-- reading declined_by (dashboard "Declined by" row) doesn't need to
-- defensively dedupe itself, and the pool-exclusion checks in assign-ride
-- stay correct either way.
CREATE OR REPLACE FUNCTION append_declined_by(p_ride_id uuid, p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.rides
  SET declined_by = array_append(declined_by, p_driver_id)
  WHERE id = p_ride_id
    AND p_driver_id IS NOT NULL
    AND NOT (p_driver_id = ANY(COALESCE(declined_by, ARRAY[]::uuid[])));
END;
$$;
