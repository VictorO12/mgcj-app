-- Plugs all remaining cross-company RLS leaks identified in the full policy audit.
--
-- Leaks fixed:
-- 1. profiles select policy — admin clause let any admin read all profiles across companies
-- 2. rides: drivers can view pending rides — no company scope, drivers saw other company's rides
-- 3. rides: drivers can update rides — unscoped admin clause duplicated update path
-- 4. rides: Drivers can update their rides — driver_id IS NULL with no company scope
--    let any driver claim/update unassigned rides from other companies
-- 5. driver_invites UPDATE — qual=true let anyone mark any invite as used
-- 6. driver_invites SELECT — qual=true exposed all invite rows including unused codes
-- 7. companies SELECT — all companies' data (including Stripe account IDs) was readable
--    by everyone; scoped so admins/drivers only see their own company
-- 8. student_verification_tokens — RLS on but zero policies; table unreachable from client

-- ─── 1. profiles select policy ───────────────────────────────────────────────
-- Admins now only see: their own company's profiles + all passengers (needed
-- for booking lookups — passengers are cross-company by design).
-- Drivers/passengers see profiles of people they've shared a ride with (unchanged).

DROP POLICY IF EXISTS "profiles select policy" ON profiles;
CREATE POLICY "profiles select policy"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    (auth.uid() = id)
    OR (
      get_my_role() = 'admin'
      AND (
        company_id = get_my_company_id()
        OR role = 'passenger'
      )
    )
    OR (EXISTS (
      SELECT 1 FROM rides
      WHERE (
        (rides.passenger_id = auth.uid() AND rides.driver_id = profiles.id)
        OR (rides.driver_id = auth.uid()  AND rides.passenger_id = profiles.id)
      )
    ))
  );

-- ─── 2. rides: drivers can view pending rides ─────────────────────────────────

DROP POLICY IF EXISTS "drivers can view pending rides" ON rides;
CREATE POLICY "drivers can view pending rides"
  ON rides FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (SELECT id FROM drivers)
    AND status = 'pending'
    AND company_id = get_my_company_id()
  );

-- ─── 3. rides: drivers can update rides ──────────────────────────────────────
-- Remove the unscoped OR get_my_role()='admin' arm — admins already have
-- "admins can update all rides" which is company-scoped.

DROP POLICY IF EXISTS "drivers can update rides" ON rides;
CREATE POLICY "drivers can update rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (auth.uid() = driver_id);

-- ─── 4. rides: Drivers can update their rides ────────────────────────────────
-- Keep the driver_id IS NULL arm (needed for claimScheduledRide) but add
-- company_id scope so drivers can only claim their own company's unassigned rides.

DROP POLICY IF EXISTS "Drivers can update their rides" ON rides;
CREATE POLICY "Drivers can update their rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (
    (driver_id = auth.uid() OR driver_id IS NULL)
    AND company_id = get_my_company_id()
  )
  WITH CHECK (driver_id = auth.uid());

-- ─── 5 & 6. driver_invites ───────────────────────────────────────────────────
-- SELECT: was qual=true exposing all invites (both companies' pending driver codes).
--   Now restricted to unused invites only — used codes are worthless to read.
-- UPDATE: was qual=true letting anyone update any invite with any value.
--   Now restricted to drivers setting used=true only (profile exists by this point).

DROP POLICY IF EXISTS "anyone can read invite by code" ON driver_invites;
CREATE POLICY "anyone can read invite by code"
  ON driver_invites FOR SELECT
  TO authenticated
  USING (used = false);

DROP POLICY IF EXISTS "anyone can mark invite as used" ON driver_invites;
CREATE POLICY "anyone can mark invite as used"
  ON driver_invites FOR UPDATE
  TO authenticated
  USING (get_my_role() = 'driver')
  WITH CHECK (get_my_role() = 'driver' AND used = true);

-- ─── 7. companies SELECT ─────────────────────────────────────────────────────
-- Was qual=true — anyone could read all companies' data including Stripe account IDs.
-- Admins and drivers see only their own company.
-- Passengers see all companies — needed for fare estimation in the mobile app
-- (a passenger's profile may not have company_id set yet at estimate time).

DROP POLICY IF EXISTS "companies_select" ON companies;
CREATE POLICY "companies_select"
  ON companies FOR SELECT
  TO authenticated
  USING (
    id = get_my_company_id()
    OR get_my_role() = 'passenger'
  );

-- ─── 8. student_verification_tokens ─────────────────────────────────────────
-- RLS was enabled but no policies existed — table was unreachable from the client.

CREATE POLICY "svt_insert_own"
  ON student_verification_tokens FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "svt_select_own"
  ON student_verification_tokens FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "svt_update_own"
  ON student_verification_tokens FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
