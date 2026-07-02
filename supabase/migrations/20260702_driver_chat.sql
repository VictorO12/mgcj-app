-- 1:1 dispatch <-> driver chat. Distinct from the broadcast `messages` table on
-- purpose: this is a 2-party thread (any admin at the company on one side, one
-- driver on the other), not a many-recipient announcement, so it gets its own
-- shape rather than overloading messages' category/display_mode/expires_at fields.
--
-- Read tracking uses a single last-read-at row per driver rather than per-message
-- reads (like message_reads) -- a 2-sided thread doesn't need a row per recipient,
-- unread is just "messages from the other side newer than my last_read_at".

CREATE TABLE driver_chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES profiles(id),
  sender_role text NOT NULL CHECK (sender_role IN ('admin', 'driver')),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX driver_chat_messages_thread_idx ON driver_chat_messages (company_id, driver_id, created_at);

CREATE TABLE driver_chat_state (
  driver_id             uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  last_read_by_driver_at timestamptz NOT NULL DEFAULT '1970-01-01',
  last_read_by_admin_at  timestamptz NOT NULL DEFAULT '1970-01-01'
);

-- Grants for PostgREST access
GRANT SELECT, INSERT ON driver_chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON driver_chat_state TO authenticated;

ALTER TABLE driver_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_chat_state ENABLE ROW LEVEL SECURITY;

-- Admins can read/send within their own company; drivers can read/send only their own thread.
CREATE POLICY driver_chat_messages_select ON driver_chat_messages
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

CREATE POLICY driver_chat_messages_insert_admin ON driver_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'admin'
    AND company_id = get_my_company_id()
    AND sender_id = auth.uid()
    AND sender_role = 'admin'
  );

CREATE POLICY driver_chat_messages_insert_driver ON driver_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'driver'
    AND driver_id = auth.uid()
    AND sender_id = auth.uid()
    AND sender_role = 'driver'
    AND company_id = get_my_company_id()
  );

-- driver_chat_state: admins can read/upsert any row in their company (shared
-- read-state, since dispatch is a shared inbox not per-admin); a driver can
-- only read/upsert their own row.
CREATE POLICY driver_chat_state_select ON driver_chat_state
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

CREATE POLICY driver_chat_state_insert ON driver_chat_state
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid() AND company_id = get_my_company_id())
  );

CREATE POLICY driver_chat_state_update ON driver_chat_state
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  )
  WITH CHECK (
    (get_my_role() = 'admin' AND company_id = get_my_company_id())
    OR (get_my_role() = 'driver' AND driver_id = auth.uid())
  );

-- Realtime: added in the same migration as table creation this time, not as an
-- afterthought (messages needed a follow-up fix for exactly this).
ALTER PUBLICATION supabase_realtime ADD TABLE driver_chat_messages;
