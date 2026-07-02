-- Dispatch announcements/offers to passengers, and (future) messages to drivers.
-- target_type/target_id already model the driver case so a second migration
-- isn't needed when driver messaging is built next; only 'all_passengers' is
-- exercised by RLS/UI today.

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  sender_id uuid NOT NULL REFERENCES profiles(id),
  category text NOT NULL CHECK (category IN ('announcement', 'offer')),
  target_type text NOT NULL DEFAULT 'all_passengers' CHECK (target_type IN ('all_passengers', 'all_drivers', 'driver')),
  target_id uuid REFERENCES profiles(id),
  display_mode text NOT NULL CHECK (display_mode IN ('inbox', 'popup')),
  title text NOT NULL,
  body text NOT NULL,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_reads (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, profile_id)
);

-- Grants for PostgREST access (tables created after Oct 30 2026 need explicit grants)
GRANT SELECT, INSERT ON messages TO authenticated;
GRANT SELECT, INSERT ON message_reads TO authenticated;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;

-- Passengers can read broadcasts to their company that were sent after they signed up.
CREATE POLICY "passengers read their announcements"
ON messages FOR SELECT
TO authenticated
USING (
  company_id = get_my_company_id()
  AND get_my_role() = 'passenger'
  AND target_type = 'all_passengers'
  AND created_at >= (SELECT created_at FROM profiles WHERE id = auth.uid())
);

-- Dispatch admins can send messages within their own company.
CREATE POLICY "admins send messages"
ON messages FOR INSERT
TO authenticated
WITH CHECK (
  get_my_role() = 'admin'
  AND company_id = get_my_company_id()
  AND sender_id = auth.uid()
);

-- Dispatch admins can review what they've sent for their company.
CREATE POLICY "admins read their company messages"
ON messages FOR SELECT
TO authenticated
USING (
  get_my_role() = 'admin'
  AND company_id = get_my_company_id()
);

-- Users can mark their own read receipts, and only see their own.
CREATE POLICY "users manage their own read receipts"
ON message_reads FOR ALL
TO authenticated
USING (profile_id = auth.uid())
WITH CHECK (profile_id = auth.uid());

-- Storage bucket for optional announcement/offer photos.
INSERT INTO storage.buckets (id, name, public)
VALUES ('message-images', 'message-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "admins upload message images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'message-images'
  AND get_my_role() = 'admin'
);

CREATE POLICY "anyone can view message images"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'message-images');
