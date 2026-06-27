-- Fix infinite recursion introduced by 20260625_admin_company_isolation.sql.
--
-- The recursion chain was:
--   profiles (select policy EXISTS on rides)
--   → rides (drivers can view pending rides subqueries drivers)
--   → drivers (admins can read all drivers EXISTS on profiles)
--   → profiles → ...
--
-- Any plain SQL EXISTS on a table with RLS inside another RLS policy can form
-- this cycle. The fix is to wrap cross-table checks in SECURITY DEFINER
-- functions, which bypass RLS and break the chain.

-- ── Helper: is the given driver_id in the current admin's company? ────────────
CREATE OR REPLACE FUNCTION admin_driver_in_my_company(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = p_driver_id
      AND profiles.company_id = get_my_company_id()
  );
$$;

-- ── Helper: is the given ride_id in the current admin's company? ─────────────
CREATE OR REPLACE FUNCTION admin_ride_in_my_company(p_ride_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM rides
    WHERE rides.id = p_ride_id
      AND rides.company_id = get_my_company_id()
  );
$$;

-- ── drivers: replace EXISTS-on-profiles with SECURITY DEFINER call ────────────
DROP POLICY IF EXISTS "admins can read all drivers" ON drivers;
CREATE POLICY "admins can read all drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND admin_driver_in_my_company(drivers.id)
  );

-- ── driver_reports: replace EXISTS-on-profiles with SECURITY DEFINER call ─────
DROP POLICY IF EXISTS "Dispatchers can read all reports" ON driver_reports;
CREATE POLICY "Dispatchers can read all reports"
  ON driver_reports FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND admin_driver_in_my_company(driver_reports.driver_id)
  );

DROP POLICY IF EXISTS "Dispatchers can update report status" ON driver_reports;
CREATE POLICY "Dispatchers can update report status"
  ON driver_reports FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND admin_driver_in_my_company(driver_reports.driver_id)
  );

-- ── ride_reviews: replace EXISTS-on-rides with SECURITY DEFINER call ──────────
DROP POLICY IF EXISTS "admin_read_all_reviews" ON ride_reviews;
CREATE POLICY "admin_read_all_reviews"
  ON ride_reviews FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND admin_ride_in_my_company(ride_reviews.ride_id)
  );

DROP POLICY IF EXISTS "Dispatchers can update reviews" ON ride_reviews;
CREATE POLICY "Dispatchers can update reviews"
  ON ride_reviews FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND admin_ride_in_my_company(ride_reviews.ride_id)
  );

GRANT EXECUTE ON FUNCTION admin_driver_in_my_company(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_ride_in_my_company(uuid) TO authenticated;
