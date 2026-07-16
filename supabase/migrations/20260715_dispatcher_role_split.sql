-- Admin/dispatcher role split.
--
-- Previously every dispatch user was `profiles.role = 'admin'`, all peers with
-- identical access (see root CLAUDE.md's now-superseded "deferred" note).
-- This introduces a 'dispatcher' role: day-to-day ride ops (rides, drivers,
-- announcements, messages, driver reports, support tickets, analytics) are
-- shared with admins; company configuration (pricing, vehicle classes,
-- discounts) and staff provisioning stay admin-only.
--
-- Provisioning is admin-driven (no self-serve signup) via a separate
-- `create-staff-account` Edge Function — not part of this migration.

-- ─── 1. Widen profiles.role ────────────────────────────────────────────────
-- Constraint name is unknown (predates the migrations folder / was applied
-- directly via the SQL editor), so find and drop it dynamically rather than
-- guessing the default Postgres-generated name.

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'profiles'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'dispatcher', 'driver', 'passenger'));

-- ─── 2. is_staff() helper ───────────────────────────────────────────────────
-- 'admin' or 'dispatcher' — both are dispatch staff for ops purposes.
-- get_my_role() is already SECURITY DEFINER (avoids the profiles-RLS
-- recursion documented in root CLAUDE.md), so this just wraps it.

CREATE OR REPLACE FUNCTION is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT get_my_role() IN ('admin', 'dispatcher');
$$;

GRANT EXECUTE ON FUNCTION is_staff() TO authenticated;

-- ─── 3. Ops-table RLS: admin-only -> shared staff ──────────────────────────

-- profiles (dispatch needs to read driver/passenger profiles for ops)
DROP POLICY IF EXISTS "profiles select policy" ON profiles;
CREATE POLICY "profiles select policy"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    (auth.uid() = id)
    OR (
      is_staff()
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

-- profiles: driver account-status management (deactivate/reactivate)
DROP POLICY IF EXISTS "admins can manage driver account status" ON profiles;
CREATE POLICY "admins can manage driver account status"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    is_staff()
    AND role = 'driver'
    AND company_id = get_my_company_id()
  )
  WITH CHECK (
    is_staff()
    AND role = 'driver'
    AND company_id = get_my_company_id()
  );

-- rides
DROP POLICY IF EXISTS "admins can read all rides" ON rides;
CREATE POLICY "admins can read all rides"
  ON rides FOR SELECT
  TO authenticated
  USING (is_staff() AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "admins can update all rides" ON rides;
CREATE POLICY "admins can update all rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (is_staff() AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "admins can insert rides" ON rides;
CREATE POLICY "admins can insert rides"
  ON rides FOR INSERT
  TO authenticated
  WITH CHECK (is_staff() AND company_id = get_my_company_id());

-- drivers
DROP POLICY IF EXISTS "admins can read all drivers" ON drivers;
CREATE POLICY "admins can read all drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    is_staff()
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  );

DROP POLICY IF EXISTS "admins can update drivers in their company" ON drivers;
CREATE POLICY "admins can update drivers in their company"
  ON drivers FOR UPDATE
  TO authenticated
  USING (
    is_staff()
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  )
  WITH CHECK (
    is_staff()
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- driver_invites (dispatch owns driver onboarding operationally)
DROP POLICY IF EXISTS "admins can manage invites" ON driver_invites;
CREATE POLICY "admins can manage invites"
  ON driver_invites FOR ALL
  TO authenticated
  USING (is_staff() AND company_id = get_my_company_id())
  WITH CHECK (is_staff() AND company_id = get_my_company_id());

-- driver_reports
DROP POLICY IF EXISTS "Dispatchers can read all reports" ON driver_reports;
CREATE POLICY "Dispatchers can read all reports"
  ON driver_reports FOR SELECT
  TO authenticated
  USING (
    is_staff()
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
    is_staff()
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- ride_reviews (Analytics is fully shared, including mark-reviewed)
DROP POLICY IF EXISTS "admin_read_all_reviews" ON ride_reviews;
CREATE POLICY "admin_read_all_reviews"
  ON ride_reviews FOR SELECT
  TO authenticated
  USING (
    is_staff()
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
    is_staff()
    AND EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_reviews.ride_id
        AND rides.company_id = get_my_company_id()
    )
  );

-- dispatch_reports (Settings -> Support is shared)
DROP POLICY IF EXISTS "admins submit reports" ON dispatch_reports;
CREATE POLICY "admins submit reports"
  ON dispatch_reports FOR INSERT
  TO authenticated
  WITH CHECK (
    is_staff()
    AND company_id = get_my_company_id()
    AND admin_id = auth.uid()
  );

DROP POLICY IF EXISTS "admins read their company reports" ON dispatch_reports;
CREATE POLICY "admins read their company reports"
  ON dispatch_reports FOR SELECT
  TO authenticated
  USING (is_staff() AND company_id = get_my_company_id());

-- dispatch_events (audit log — dispatchers' actions get logged too)
DROP POLICY IF EXISTS "Dispatchers can insert own company events" ON dispatch_events;
CREATE POLICY "Dispatchers can insert own company events"
  ON dispatch_events FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id = get_my_company_id()
    AND dispatcher_id = auth.uid()
    AND is_staff()
  );

-- messages (Announcements)
DROP POLICY IF EXISTS messages_insert_admin ON messages;
CREATE POLICY messages_insert_admin ON messages
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND is_staff());

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages
  FOR SELECT TO authenticated
  USING (
    company_id = get_my_company_id() AND (
      (target_type = 'all_passengers' AND get_my_role() = 'passenger')
      OR (target_type = 'all_drivers' AND get_my_role() = 'driver')
      OR (target_type = 'driver' AND target_id = auth.uid())
      OR is_staff()
    )
  );

DROP POLICY IF EXISTS "admins upload message images" ON storage.objects;
CREATE POLICY "admins upload message images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'message-images' AND is_staff());

-- driver_chat_messages / driver_chat_state (1:1 dispatch <-> driver chat)
DROP POLICY IF EXISTS driver_chat_messages_select ON driver_chat_messages;
CREATE POLICY driver_chat_messages_select ON driver_chat_messages
  FOR SELECT TO authenticated
  USING (
    (is_staff() AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

DROP POLICY IF EXISTS driver_chat_messages_insert_admin ON driver_chat_messages;
CREATE POLICY driver_chat_messages_insert_admin ON driver_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    is_staff()
    AND company_id = get_my_company_id()
    AND sender_id = auth.uid()
    AND sender_role = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
    )
  );

DROP POLICY IF EXISTS driver_chat_state_select ON driver_chat_state;
CREATE POLICY driver_chat_state_select ON driver_chat_state
  FOR SELECT TO authenticated
  USING (
    (is_staff() AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

DROP POLICY IF EXISTS driver_chat_state_insert ON driver_chat_state;
CREATE POLICY driver_chat_state_insert ON driver_chat_state
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      is_staff()
      AND company_id = get_my_company_id()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
      )
    )
    OR (get_my_role() = 'driver' AND driver_id = auth.uid() AND company_id = get_my_company_id())
  );

DROP POLICY IF EXISTS driver_chat_state_update ON driver_chat_state;
CREATE POLICY driver_chat_state_update ON driver_chat_state
  FOR UPDATE TO authenticated
  USING (
    (is_staff() AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  )
  WITH CHECK (
    (
      is_staff()
      AND company_id = get_my_company_id()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
      )
    )
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

-- ─── 4. guard_ride_fare_fields trigger: dispatchers edit fares too ─────────
-- Same fare-edit workflow as admins (DashboardPage's saveRideEdits), just
-- widened from get_my_role() = 'admin' to is_staff().

CREATE OR REPLACE FUNCTION guard_ride_fare_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF is_staff() THEN
    RETURN NEW;
  END IF;

  IF NEW.fare_estimate      IS DISTINCT FROM OLD.fare_estimate
     OR NEW.pre_discount_fare IS DISTINCT FROM OLD.pre_discount_fare
     OR NEW.discount_amount   IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_type     IS DISTINCT FROM OLD.discount_type THEN
    RAISE EXCEPTION 'Fare fields are read-only';
  END IF;

  RETURN NEW;
END;
$$;

-- ─── 5. vehicle_classes: close a pre-existing gap, keep strictly admin-only ─
-- These INSERT/UPDATE/DELETE policies were only ever scoped by company_id,
-- with NO role check at all -- any authenticated member of the company
-- (including passengers/drivers, and now dispatchers) could write pricing
-- surcharges. Per the admin/dispatcher split, vehicle class config stays
-- admin-only, so this both fixes the gap and enforces the new boundary.

DROP POLICY IF EXISTS "Admins insert vehicle classes" ON vehicle_classes;
CREATE POLICY "Admins insert vehicle classes"
  ON vehicle_classes FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'admin' AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "Admins update vehicle classes" ON vehicle_classes;
CREATE POLICY "Admins update vehicle classes"
  ON vehicle_classes FOR UPDATE TO authenticated
  USING (get_my_role() = 'admin' AND company_id = get_my_company_id())
  WITH CHECK (get_my_role() = 'admin' AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "Admins delete vehicle classes" ON vehicle_classes;
CREATE POLICY "Admins delete vehicle classes"
  ON vehicle_classes FOR DELETE TO authenticated
  USING (get_my_role() = 'admin' AND company_id = get_my_company_id());

-- ─── 6. dispatch_events: add staff.* events, and fix a pre-existing bug ────
-- SettingsPage.tsx has logged `dispatch_report.submitted` on every Support
-- ticket since the Support tab shipped (20260712_dispatch_reports.sql), but
-- that event type was never added to this check constraint -- so the insert
-- has been silently failing (logDispatchEvent doesn't surface the error to
-- the user) since day one. Fixed here since this migration already touches
-- the constraint to add staff.* events for the new create-staff-account flow.

ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_type_check;
ALTER TABLE dispatch_events ADD CONSTRAINT dispatch_events_event_type_check check (event_type in (
  'ride.created',
  'ride.cancelled',
  'ride.assigned',
  'ride.reassigned',
  'ride.scheduled_modified',
  'ride.notes_added',
  'ride.fare_changed',
  'driver.suspended',
  'driver.reactivated',
  'driver.deleted',
  'driver.vehicle_updated',
  'invite.created',
  'invite.revoked',
  'discount.created',
  'discount.deactivated',
  'discount.deleted',
  'report.reviewed',
  'report.dismissed',
  'report.printed',
  'announcement.drivers',
  'announcement.passengers',
  'escalation.acknowledged',
  'export.csv',
  'export.pdf',
  'invoice.printed',
  'settings.pricing_updated',
  'settings.vehicle_class_created',
  'settings.vehicle_class_updated',
  'settings.vehicle_class_status_changed',
  'dispatch_report.submitted',
  'staff.created',
  'staff.deactivated',
  'staff.reactivated'
));

-- ─── 7. Staff account management (admin-only) ──────────────────────────────
-- Account creation itself goes through the create-staff-account Edge Function
-- (service role, bypasses RLS). This policy covers direct dashboard writes an
-- admin makes to an existing staff row -- e.g. deactivating a dispatcher.

DROP POLICY IF EXISTS "admins can manage staff account status" ON profiles;
CREATE POLICY "admins can manage staff account status"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND role IN ('admin', 'dispatcher')
    AND company_id = get_my_company_id()
  )
  WITH CHECK (
    get_my_role() = 'admin'
    AND role IN ('admin', 'dispatcher')
    AND company_id = get_my_company_id()
  );
