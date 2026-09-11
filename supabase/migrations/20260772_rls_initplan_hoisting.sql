-- Wrap no-argument RLS helper calls in scalar subqueries so Postgres evaluates
-- them ONCE per statement as an InitPlan, instead of once per row.
--
-- Semantically identical: same functions, same arguments, same results, same
-- SECURITY DEFINER. `(select f())` only changes WHEN the planner evaluates it.
--
-- Measured on live data 2026-09-11, `select * from rides where company_id = ...
-- order by created_at desc limit 150` as `authenticated`:
--
--     before   11.084 ms
--     after     4.582 ms      (wrapping ONE of five OR branches)
--
-- Context: `get_my_role()` was VOLATILE (now STABLE), which is why nothing was
-- ever hoisted. Note STABLE alone did NOT help — measured, 6.9ms -> 6.69ms.
-- The marking permits hoisting; the scalar subquery is what forces it. Both
-- are needed, and neither is optional.
--
-- Functions taking the row as an argument -- driver_in_my_company(id),
-- admin_driver_in_my_company(id), shares_ride_with(id) -- are deliberately NOT
-- wrapped: their result varies per row, so hoisting would be wrong.

-- ── rides ───────────────────────────────────────────────────────────────────

ALTER POLICY "admins can read all rides" ON rides
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND (company_id = (select get_my_company_id()))
  );

ALTER POLICY "admins can update all rides" ON rides
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND (company_id = (select get_my_company_id()))
  );

ALTER POLICY "drivers can view pending rides" ON rides
  USING (
    (select is_a_driver())
    AND (status = 'pending'::text)
    AND (company_id = (select get_my_company_id()))
  );

ALTER POLICY "drivers view unclaimed scheduled rides" ON rides
  USING (
    (status = 'scheduled'::text)
    AND (driver_id IS NULL)
    AND (company_id = (select get_my_company_id()))
    AND ((select get_my_role()) = 'driver'::text)
  );

ALTER POLICY "rides: driver can select assigned" ON rides
  USING ((select auth.uid()) = driver_id);

ALTER POLICY "rides: passenger can select own" ON rides
  USING ((select auth.uid()) = passenger_id);

ALTER POLICY "rides: passenger can update own" ON rides
  USING ((select auth.uid()) = passenger_id);

ALTER POLICY "drivers can update rides" ON rides
  USING ((select auth.uid()) = driver_id);

ALTER POLICY "Drivers can update their rides" ON rides
  USING (
    (((driver_id = (select auth.uid())) OR (driver_id IS NULL)))
    AND (company_id = (select get_my_company_id()))
  );

-- ── drivers ─────────────────────────────────────────────────────────────────

ALTER POLICY "admins can read all drivers" ON drivers
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND driver_in_my_company(id)
  );

ALTER POLICY "admins can update drivers in their company" ON drivers
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND driver_in_my_company(id)
  );

ALTER POLICY "passengers can view active drivers" ON drivers
  USING (
    (is_active = true)
    AND ((select get_my_role()) <> 'admin'::text)
    AND admin_driver_in_my_company(id)
  );

ALTER POLICY "drivers can view own driver record" ON drivers
  USING ((select auth.uid()) = id);

ALTER POLICY "drivers: select own" ON drivers
  USING ((select auth.uid()) = id);

ALTER POLICY "drivers: update own" ON drivers
  USING ((select auth.uid()) = id);

-- ── profiles ────────────────────────────────────────────────────────────────

ALTER POLICY "profiles select policy" ON profiles
  USING (
    ((select auth.uid()) = id)
    OR (((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
        AND ((company_id = (select get_my_company_id())) OR (role = 'passenger'::text)))
    OR shares_ride_with(id)
  );

ALTER POLICY "Users can read own profile" ON profiles
  USING ((select auth.uid()) = id);

ALTER POLICY "Users can update own profile" ON profiles
  USING ((select auth.uid()) = id);

ALTER POLICY "profiles: update own" ON profiles
  USING ((select auth.uid()) = id);

ALTER POLICY "admins can manage dispatcher account status" ON profiles
  USING (
    ((select get_my_role()) = 'admin'::text)
    AND (role = 'dispatcher'::text)
    AND (company_id = (select get_my_company_id()))
  );

ALTER POLICY "admins can manage driver account status" ON profiles
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND (role = 'driver'::text)
    AND (company_id = (select get_my_company_id()))
  );

-- ── driver_reports ──────────────────────────────────────────────────────────

ALTER POLICY "Dispatchers can read all reports" ON driver_reports
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND (EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = (select get_my_company_id())
    ))
  );

ALTER POLICY "Dispatchers can update report status" ON driver_reports
  USING (
    ((select get_my_role()) = ANY (ARRAY['admin'::text, 'dispatcher'::text]))
    AND (EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = (select get_my_company_id())
    ))
  );

ALTER POLICY "Passengers can view their own reports" ON driver_reports
  USING (passenger_id = (select auth.uid()));
