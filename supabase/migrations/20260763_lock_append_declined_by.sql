-- append_declined_by is anon-callable and mutating. Lock it to service_role.
--
-- 20260712 created it SECURITY DEFINER with no REVOKE at all, so Supabase's
-- default grants left EXECUTE with anon and authenticated (proacl showed
-- `anon=X/postgres`). Both parameters are caller-supplied and neither is
-- checked against auth.uid():
--
--     append_declined_by(p_ride_id uuid, p_driver_id uuid)
--
-- assign-ride treats a hard decline as PERMANENT exclusion of that driver for
-- that ride (as opposed to a timeout, which is eligible again on the second
-- cycling pass). So anyone able to call this can name every driver at a company
-- against a live ride and make it permanently unassignable -- a denial of
-- dispatch, per ride, with no trace beyond a declined_by array that looks
-- ordinary. Ride and driver UUIDs are both visible to app users through normal
-- flows (passengers see driver ids via DriverProfileSheet).
--
-- All three callers use the service-role client, so nothing legitimate loses
-- access: decline-assigned-ride, assign-ride, settle-ride.
--
-- Third instance of the pattern in 20260734 / 20260762 -- see those headers.
-- Also adds the SET search_path that a SECURITY DEFINER should always pin.

CREATE OR REPLACE FUNCTION public.append_declined_by(p_ride_id uuid, p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.rides
     SET declined_by = array_append(declined_by, p_driver_id)
   WHERE id = p_ride_id
     AND p_driver_id IS NOT NULL
     AND NOT (p_driver_id = ANY(COALESCE(declined_by, ARRAY[]::uuid[])));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.append_declined_by(uuid, uuid)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.append_declined_by(uuid, uuid)
  TO service_role;
