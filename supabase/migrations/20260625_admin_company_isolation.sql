-- Fix admin data isolation: scope all admin-level RLS policies to the admin's company.
-- Previously admins could see rides, drivers, invites, reports, and reviews across
-- all companies. Each policy below is dropped and recreated with a get_my_company_id()
-- guard.

-- ─── driver_invites: add company_id column ───────────────────────────────────

ALTER TABLE driver_invites
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);

-- Backfill from the creating admin's profile
UPDATE driver_invites di
SET company_id = p.company_id
FROM profiles p
WHERE p.id = di.created_by
  AND di.company_id IS NULL;

-- ─── rides ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admins can read all rides" ON rides;
CREATE POLICY "admins can read all rides"
  ON rides FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
  );

DROP POLICY IF EXISTS "admins can update all rides" ON rides;
CREATE POLICY "admins can update all rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
  );

DROP POLICY IF EXISTS "admins can insert rides" ON rides;
CREATE POLICY "admins can insert rides"
  ON rides FOR INSERT
  TO authenticated
  WITH CHECK (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
  );

-- ─── drivers ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admins can read all drivers" ON drivers;
CREATE POLICY "admins can read all drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- ─── driver_invites ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admins can manage invites" ON driver_invites;
CREATE POLICY "admins can manage invites"
  ON driver_invites FOR ALL
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
  )
  WITH CHECK (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
  );

-- ─── driver_reports ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Dispatchers can read all reports" ON driver_reports;
CREATE POLICY "Dispatchers can read all reports"
  ON driver_reports FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = get_my_company_id()
    )
  );

DROP POLICY IF EXISTS "Dispatchers can update report status" ON driver_reports;
CREATE POLICY "Dispatchers can update report status"
  ON driver_reports FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- ─── ride_reviews ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "admin_read_all_reviews" ON ride_reviews;
CREATE POLICY "admin_read_all_reviews"
  ON ride_reviews FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_reviews.ride_id
        AND rides.company_id = get_my_company_id()
    )
  );

DROP POLICY IF EXISTS "Dispatchers can update reviews" ON ride_reviews;
CREATE POLICY "Dispatchers can update reviews"
  ON ride_reviews FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_reviews.ride_id
        AND rides.company_id = get_my_company_id()
    )
  );

-- Grant access so PostgREST can reach the new column
GRANT SELECT, INSERT, UPDATE ON driver_invites TO authenticated;
