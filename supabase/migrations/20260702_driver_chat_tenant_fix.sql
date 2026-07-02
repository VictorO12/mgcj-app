-- Security fix: the admin-side INSERT/UPDATE policies on driver_chat_messages and
-- driver_chat_state checked company_id = get_my_company_id() (the row's own stamped
-- company) but never verified the target driver_id actually belongs to a driver in
-- that company. A rogue admin could plant a driver_chat_messages row (or upsert
-- driver_chat_state) for a driver at a DIFFERENT company -- visible to that driver
-- (whose SELECT policy only checks driver_id = auth.uid(), no company check) but
-- invisible to that driver's own company's admins. Same bug class already fixed
-- once in 20260625_admin_company_isolation.sql / 20260627_fix_remaining_leaks.sql.

DROP POLICY IF EXISTS driver_chat_messages_insert_admin ON driver_chat_messages;
CREATE POLICY driver_chat_messages_insert_admin ON driver_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
    AND sender_id = auth.uid()
    AND sender_role = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
    )
  );

DROP POLICY IF EXISTS driver_chat_state_insert ON driver_chat_state;
CREATE POLICY driver_chat_state_insert ON driver_chat_state
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      get_my_role() = 'admin'
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
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  )
  WITH CHECK (
    (
      get_my_role() = 'admin'
      AND company_id = get_my_company_id()
      AND EXISTS (
        SELECT 1 FROM profiles
        WHERE id = driver_id AND company_id = get_my_company_id() AND role = 'driver'
      )
    )
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );
