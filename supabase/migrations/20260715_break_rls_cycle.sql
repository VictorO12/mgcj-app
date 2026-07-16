-- Fix 42P17 infinite_recursion on profiles by breaking a cross-table RLS cycle:
--
--   profiles."profiles select policy"      -- raw EXISTS(rides)  ─┐
--   rides."drivers can view pending rides" -- raw IN(drivers)     │ triangle
--   drivers."admins can read all drivers"  -- raw EXISTS(profiles)┘ back to profiles
--
-- Raw cross-table subqueries inside a policy make Postgres expand the TARGET
-- table's RLS inline during planning. Walking profiles→rides→drivers→profiles
-- re-enters profiles and trips the recursion guard, aborting every profiles
-- SELECT (including the own-row read that login/useAuth does).
--
-- get_my_role()/get_my_company_id() are NOT the problem -- SECURITY DEFINER
-- function calls are opaque to the RLS expander. The raw EXISTS/IN subqueries
-- are. Fix: route the two profiles-referencing edges through SECURITY DEFINER
-- plpgsql helpers (same pattern as the existing admin_driver_in_my_company /
-- admin_profile_in_my_company helpers), so they no longer expand RLS inline.
-- Cutting both edges means no policy-traversal order can reform the loop.

-- ── Helper 1: does the current user share a ride with this profile? ──────────
-- Replaces the raw EXISTS(rides) in "profiles select policy" (the profiles→rides edge).
CREATE OR REPLACE FUNCTION shares_ride_with(p_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM rides
    WHERE (passenger_id = auth.uid() AND driver_id = p_profile_id)
       OR (driver_id = auth.uid() AND passenger_id = p_profile_id)
  ) INTO v;
  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION shares_ride_with(uuid) TO authenticated;

-- ── Helper 2: is this driver's profile in my company? ───────────────────────
-- Replaces the raw EXISTS(profiles) in the admin drivers policies (the drivers→profiles edge).
CREATE OR REPLACE FUNCTION driver_in_my_company(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_driver_id
      AND company_id = get_my_company_id()
  ) INTO v;
  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION driver_in_my_company(uuid) TO authenticated;

-- ── Edge 1: profiles select policy — wrap EXISTS(rides) ─────────────────────
DROP POLICY IF EXISTS "profiles select policy" ON profiles;
CREATE POLICY "profiles select policy"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    (auth.uid() = id)
    OR (
      get_my_role() IN ('admin', 'dispatcher')
      AND (
        company_id = get_my_company_id()
        OR role = 'passenger'
      )
    )
    OR shares_ride_with(id)
  );

-- ── Edge 3: admin drivers policies — wrap EXISTS(profiles) ───────────────────
DROP POLICY IF EXISTS "admins can read all drivers" ON drivers;
CREATE POLICY "admins can read all drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
    AND driver_in_my_company(drivers.id)
  );

DROP POLICY IF EXISTS "admins can update drivers in their company" ON drivers;
CREATE POLICY "admins can update drivers in their company"
  ON drivers FOR UPDATE
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
    AND driver_in_my_company(drivers.id)
  )
  WITH CHECK (
    get_my_role() IN ('admin', 'dispatcher')
    AND driver_in_my_company(drivers.id)
  );
