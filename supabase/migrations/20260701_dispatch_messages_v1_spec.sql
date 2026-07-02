-- Brings the messages/message_reads tables (created in 20260701_dispatch_messages.sql)
-- in line with the v1 spec: expires_at, 'interstitial' display mode (was 'popup'),
-- 'message' category reserved for future driver targeting, target_id presence
-- constraint, a company/created_at index, cascading FKs, and tightened RLS.

-- 1. New column: offers/announcements can be time-boxed.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- 2. Rename display_mode value 'popup' -> 'interstitial' before touching the constraint.
UPDATE messages SET display_mode = 'interstitial' WHERE display_mode = 'popup';

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_display_mode_check;
ALTER TABLE messages ADD CONSTRAINT messages_display_mode_check
  CHECK (display_mode IN ('inbox', 'interstitial'));

-- 3. Reserve 'message' category for future driver-targeted messages.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_category_check;
ALTER TABLE messages ADD CONSTRAINT messages_category_check
  CHECK (category IN ('announcement', 'offer', 'message'));

-- 4. target_id must be set for driver-targeted rows, and only those.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS target_id_presence;
ALTER TABLE messages ADD CONSTRAINT target_id_presence
  CHECK (
    (target_type = 'driver' AND target_id IS NOT NULL)
    OR (target_type IN ('all_passengers', 'all_drivers') AND target_id IS NULL)
  );

-- 5. Read-path index: every query filters/orders by (company_id, created_at desc).
CREATE INDEX IF NOT EXISTS messages_company_created_idx ON messages (company_id, created_at DESC);

-- 6. Cascading FKs so a deleted company/profile doesn't orphan messages/reads.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_company_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE message_reads DROP CONSTRAINT IF EXISTS message_reads_profile_id_fkey;
ALTER TABLE message_reads ADD CONSTRAINT message_reads_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- 7. RLS: consolidate the two passenger/admin select policies into one,
-- and tighten message_reads from FOR ALL down to select+insert only.
DROP POLICY IF EXISTS "passengers read their announcements" ON messages;
DROP POLICY IF EXISTS "admins read their company messages" ON messages;
DROP POLICY IF EXISTS "admins send messages" ON messages;
DROP POLICY IF EXISTS "users manage their own read receipts" ON message_reads;

CREATE POLICY messages_insert_admin ON messages
  FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id() AND get_my_role() = 'admin');

CREATE POLICY messages_select ON messages
  FOR SELECT TO authenticated
  USING (
    company_id = get_my_company_id() AND (
      (target_type = 'all_passengers' AND get_my_role() = 'passenger')
      OR (target_type = 'all_drivers' AND get_my_role() = 'driver')
      OR (target_type = 'driver' AND target_id = auth.uid())
      OR get_my_role() = 'admin'
    )
  );

CREATE POLICY message_reads_select ON message_reads
  FOR SELECT TO authenticated USING (profile_id = auth.uid());

CREATE POLICY message_reads_insert ON message_reads
  FOR INSERT TO authenticated WITH CHECK (profile_id = auth.uid());
