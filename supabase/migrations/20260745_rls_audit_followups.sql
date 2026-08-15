-- Follow-ups from the live RLS audit of 2026-08-15. Two independent fixes.
--
-- Context worth keeping: this audit happened because 20260627_fix_remaining_leaks.sql
-- was written, committed, and NEVER APPLIED — `admin_profile_in_my_company` does not
-- exist in the live database. Three of that file's seven concerns turned out to be
-- fixed anyway by later migrations, so it must not be replayed wholesale; these are
-- the two that were genuinely still open, rewritten against live state.

-- ── 1. companies: stop exposing every company to every passenger ────────────
-- Live policy was:
--   (id = get_my_company_id()) OR (get_my_role() = 'passenger')
-- The passenger arm let any passenger read EVERY company row, including
-- stripe_account_id and platform_fee_percent — cross-tenant commercial config.
--
-- It is also dead weight: every client read of `companies` in both repos is
-- `.eq("id", profile.company_id)` (app: PassengerHomeScreen pricing,
-- RideHistoryScreen payout_model, DriverEditProfileScreen payout_model;
-- dashboard: own-company settings), which the first arm already covers, since
-- get_my_company_id() reads the caller's own profiles.company_id.
--
-- A passenger with no company_id gets no row — unchanged from today, because
-- their read is already guarded by `profile?.company_id` and falls back to
-- default pricing (base 4.00 / 1.80 per km) when it returns nothing.
DROP POLICY IF EXISTS "companies_select" ON companies;
CREATE POLICY "companies_select"
  ON companies FOR SELECT
  TO authenticated
  USING (id = get_my_company_id());

-- ── 2. rides: remove a raw cross-table subquery from a policy ───────────────
-- Live policy tests driver-ness with `auth.uid() IN (SELECT drivers.id FROM drivers)`.
-- A raw subquery inside a policy is expanded inline by the RLS planner, which is
-- exactly the shape that produced the 42P17 recursion this project has already
-- been bitten by (see 20260715_break_rls_cycle.sql): the moment any policy on
-- `drivers` references `rides`, this policy closes the loop and every
-- immediate-dispatch read starts failing.
--
-- Deliberately NOT swapped for get_my_role() = 'driver' — that tests
-- profiles.role, while this tests membership in `drivers`, and a row present in
-- one but not the other would flip visibility on the board that gates immediate
-- dispatch. is_a_driver() keeps the exact same population and only makes it
-- opaque to the policy expander.
CREATE OR REPLACE FUNCTION is_a_driver()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM drivers WHERE id = auth.uid());
END;
$$;

REVOKE EXECUTE ON FUNCTION is_a_driver() FROM public, anon;
GRANT  EXECUTE ON FUNCTION is_a_driver() TO authenticated;

DROP POLICY IF EXISTS "drivers can view pending rides" ON rides;
CREATE POLICY "drivers can view pending rides"
  ON rides FOR SELECT
  TO authenticated
  USING (
    is_a_driver()
    AND status = 'pending'
    AND company_id = get_my_company_id()
  );

-- ── Deliberately NOT changed ────────────────────────────────────────────────
-- The duplicate/overlapping policies found in the audit are being left alone.
-- `rides: driver can select assigned` and `rides: passenger can select own` are
-- TO public but are the ONLY policies letting a driver or passenger see their
-- own rides — "duplicate" is the wrong read of them, and dropping either breaks
-- the app. The redundant profiles pair (`Users can read own profile` vs the
-- auth.uid() = id arm of `profiles select policy`) is genuinely subsumed, but
-- policies are OR'd so it grants nothing extra, and churning live auth policy
-- for tidiness is a bad trade.
