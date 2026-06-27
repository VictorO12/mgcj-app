-- Fix remaining cross-company RLS leaks. All cross-table subqueries in policies
-- use SECURITY DEFINER functions to avoid the recursion chain fixed earlier.

-- ── Helper: can the current admin see this profile? ───────────────────────────
-- Allows: own-company members (by company_id) + anyone who has ridden with
-- this company (passengers may not have company_id on their profile).
CREATE OR REPLACE FUNCTION admin_profile_in_my_company(p_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = p_id AND company_id = get_my_company_id()
    )
    OR EXISTS (
      SELECT 1 FROM rides
      WHERE (passenger_id = p_id OR driver_id = p_id)
        AND company_id = get_my_company_id()
    );
$$;

GRANT EXECUTE ON FUNCTION admin_profile_in_my_company(uuid) TO authenticated;

-- ── 1. profiles: admin branch was unscoped (saw all profiles) ─────────────────
DROP POLICY IF EXISTS "profiles select policy" ON profiles;
CREATE POLICY "profiles select policy"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    (auth.uid() = id)
    OR (get_my_role() = 'admin' AND admin_profile_in_my_company(id))
    OR (EXISTS (
      SELECT 1 FROM rides
      WHERE (
        (rides.passenger_id = auth.uid() AND rides.driver_id = profiles.id)
        OR (rides.driver_id = auth.uid() AND rides.passenger_id = profiles.id)
      )
    ))
  );

-- ── 2. rides: "drivers can view pending" showed all-company pending rides ──────
DROP POLICY IF EXISTS "drivers can view pending rides" ON rides;
CREATE POLICY "drivers can view pending rides"
  ON rides FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (SELECT drivers.id FROM drivers)
    AND status = 'pending'
    AND company_id = get_my_company_id()
  );

-- ── 3. rides UPDATE: "drivers can update rides" had unscoped admin branch ──────
-- "admins can update all rides" already covers the admin path with company scope.
DROP POLICY IF EXISTS "drivers can update rides" ON rides;
CREATE POLICY "drivers can update rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (auth.uid() = driver_id);

-- ── 4. rides UPDATE: "Drivers can update their rides" allowed driver_id IS NULL─
-- driver_id IS NULL means any driver could update unassigned rides from any company.
DROP POLICY IF EXISTS "Drivers can update their rides" ON rides;
CREATE POLICY "Drivers can update their rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (driver_id = auth.uid())
  WITH CHECK (driver_id = auth.uid());

-- ── 5. driver_invites UPDATE: anyone could set any field on any invite ─────────
-- Tighten WITH CHECK so the only allowed write is flipping used to true.
DROP POLICY IF EXISTS "anyone can mark invite as used" ON driver_invites;
CREATE POLICY "anyone can mark invite as used"
  ON driver_invites FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (used = true);

-- ── 6. driver_invites SELECT: qual=true exposes all invite rows ───────────────
-- Limit to unused invites only — used codes have no value but leaking pending
-- invite codes for another company is unnecessary.
DROP POLICY IF EXISTS "anyone can read invite by code" ON driver_invites;
CREATE POLICY "anyone can read invite by code"
  ON driver_invites FOR SELECT
  TO authenticated
  USING (used = false);

-- ── 7. companies SELECT: all company config readable cross-company ─────────────
-- Admins and drivers only need their own company. Passengers need their company
-- for fare estimates; those without a company_id get no rows (falls back to
-- hardcoded defaults in the app). Service-role calls (Edge Functions) bypass RLS.
DROP POLICY IF EXISTS "companies_select" ON companies;
CREATE POLICY "companies_select"
  ON companies FOR SELECT
  TO authenticated
  USING (id = get_my_company_id());
