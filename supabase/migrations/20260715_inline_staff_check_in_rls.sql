-- Fix 42P17 infinite_recursion that persisted even after making is_staff()
-- LANGUAGE plpgsql. Rather than keep chasing the planner's inlining/
-- volatility behavior, remove is_staff() from the RLS policy evaluation
-- path entirely and inline the check the same way the *working*
-- pre-split policies did: `get_my_role() = 'admin'` directly. This is
-- structurally identical to what worked before, just widened to accept
-- 'dispatcher' too.
--
-- is_staff() itself is left in place (fixed as plpgsql) for use in
-- application/edge-function code -- just not inside these RLS policies.

-- profiles
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
    OR (EXISTS (
      SELECT 1 FROM rides
      WHERE (
        (rides.passenger_id = auth.uid() AND rides.driver_id = profiles.id)
        OR (rides.driver_id = auth.uid()  AND rides.passenger_id = profiles.id)
      )
    ))
  );

DROP POLICY IF EXISTS "admins can manage driver account status" ON profiles;
CREATE POLICY "admins can manage driver account status"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
    AND role = 'driver'
    AND company_id = get_my_company_id()
  )
  WITH CHECK (
    get_my_role() IN ('admin', 'dispatcher')
    AND role = 'driver'
    AND company_id = get_my_company_id()
  );

-- rides
DROP POLICY IF EXISTS "admins can read all rides" ON rides;
CREATE POLICY "admins can read all rides"
  ON rides FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "admins can update all rides" ON rides;
CREATE POLICY "admins can update all rides"
  ON rides FOR UPDATE
  TO authenticated
  USING (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id());

DROP POLICY IF EXISTS "admins can insert rides" ON rides;
CREATE POLICY "admins can insert rides"
  ON rides FOR INSERT
  TO authenticated
  WITH CHECK (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id());

-- drivers
DROP POLICY IF EXISTS "admins can read all drivers" ON drivers;
CREATE POLICY "admins can read all drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
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
    get_my_role() IN ('admin', 'dispatcher')
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  )
  WITH CHECK (
    get_my_role() IN ('admin', 'dispatcher')
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- driver_invites
DROP POLICY IF EXISTS "admins can manage invites" ON driver_invites;
CREATE POLICY "admins can manage invites"
  ON driver_invites FOR ALL
  TO authenticated
  USING (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id())
  WITH CHECK (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id());

-- driver_reports
DROP POLICY IF EXISTS "Dispatchers can read all reports" ON driver_reports;
CREATE POLICY "Dispatchers can read all reports"
  ON driver_reports FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
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
    get_my_role() IN ('admin', 'dispatcher')
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = driver_reports.driver_id
        AND profiles.company_id = get_my_company_id()
    )
  );

-- ride_reviews
DROP POLICY IF EXISTS "admin_read_all_reviews" ON ride_reviews;
CREATE POLICY "admin_read_all_reviews"
  ON ride_reviews FOR SELECT
  TO authenticated
  USING (
    get_my_role() IN ('admin', 'dispatcher')
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
    get_my_role() IN ('admin', 'dispatcher')
    AND EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_reviews.ride_id
        AND rides.company_id = get_my_company_id()
    )
  );

-- dispatch_reports
DROP POLICY IF EXISTS "admins submit reports" ON dispatch_reports;
CREATE POLICY "admins submit reports"
  ON dispatch_reports FOR INSERT
  TO authenticated
  WITH CHECK (
    get_my_role() IN ('admin', 'dispatcher')
    AND company_id = get_my_company_id()
    AND admin_id = auth.uid()
  );

DROP POLICY IF EXISTS "admins read their company reports" ON dispatch_reports;
CREATE POLICY "admins read their company reports"
  ON dispatch_reports FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id());

-- dispatch_events
DROP POLICY IF EXISTS "Dispatchers can insert own company events" ON dispatch_events;
CREATE POLICY "Dispatchers can insert own company events"
  ON dispatch_events FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id = get_my_company_id()
    AND dispatcher_id = auth.uid()
    AND get_my_role() IN ('admin', 'dispatcher')
  );

-- messages
DROP POLICY IF EXISTS messages_insert_admin ON messages;
CREATE POLICY messages_insert_admin ON messages
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() IN ('admin', 'dispatcher'));

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages
  FOR SELECT TO authenticated
  USING (
    company_id = get_my_company_id() AND (
      (target_type = 'all_passengers' AND get_my_role() = 'passenger')
      OR (target_type = 'all_drivers' AND get_my_role() = 'driver')
      OR (target_type = 'driver' AND target_id = auth.uid())
      OR get_my_role() IN ('admin', 'dispatcher')
    )
  );

DROP POLICY IF EXISTS "admins upload message images" ON storage.objects;
CREATE POLICY "admins upload message images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'message-images' AND get_my_role() IN ('admin', 'dispatcher'));

-- driver_chat_messages / driver_chat_state
DROP POLICY IF EXISTS driver_chat_messages_select ON driver_chat_messages;
CREATE POLICY driver_chat_messages_select ON driver_chat_messages
  FOR SELECT TO authenticated
  USING (
    (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

DROP POLICY IF EXISTS driver_chat_messages_insert_admin ON driver_chat_messages;
CREATE POLICY driver_chat_messages_insert_admin ON driver_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() IN ('admin', 'dispatcher')
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
    (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

DROP POLICY IF EXISTS driver_chat_state_insert ON driver_chat_state;
CREATE POLICY driver_chat_state_insert ON driver_chat_state
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      get_my_role() IN ('admin', 'dispatcher')
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
    (get_my_role() IN ('admin', 'dispatcher') AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  )
  WITH CHECK (
    (
      get_my_role() IN ('admin', 'dispatcher')
      AND company_id = get_my_company_id()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
      )
    )
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

-- guard_ride_fare_fields trigger
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

  IF get_my_role() IN ('admin', 'dispatcher') THEN
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
