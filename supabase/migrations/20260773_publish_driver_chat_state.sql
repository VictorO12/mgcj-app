-- The chat "Seen" marker never updated live — found 2026-09-12
--
-- Both sides of dispatch<->driver chat subscribe to driver_chat_state to keep
-- the read marker current while a thread is open:
--
--   mgcj-dashboard  MessagesPage.tsx:238      reads last_read_by_driver_at
--   mgcj-app        DriverChatScreen.tsx:130  reads last_read_by_admin_at
--
-- The table was never in the supabase_realtime publication, so neither
-- callback has ever fired. The marker shows where things stood when the thread
-- was opened and then freezes.
--
-- The dashboard's subscription carries a comment asserting the opposite —
-- "driver_chat_state is already in the supabase_realtime publication, so
-- postgres_changes is the natural transport" — which is how this survived: an
-- assumption written down once and read back later as if it were a check.
-- Same family as the migration-files-are-not-applied-state rule.
--
-- Note the failure mode, because it is the reason nobody noticed for weeks:
-- subscribing to an UNPUBLISHED table is not an error. The channel returns
-- SUBSCRIBED exactly as it would otherwise and simply never delivers. There is
-- nothing in any log, on either side, to find.
--
-- Cost: negligible, and worth stating explicitly given the realtime-load work
-- this same week. driver_chat_state is one row per driver, written only when
-- someone opens a thread and their read cursor moves — not a heartbeat, and
-- nothing like the volume on `drivers`.
--
-- Replica identity is deliberately left at the default (primary key). Both
-- consumers read `payload.new` only, and the whole new row is in the WAL
-- regardless; REPLICA IDENTITY FULL would only add the old row, which neither
-- side uses, at the cost of a bigger WAL record per update.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename  = 'driver_chat_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_chat_state;
  END IF;
END $$;

-- Verify: should return one row.
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'driver_chat_state';
--
-- Reverse with:
-- alter publication supabase_realtime drop table public.driver_chat_state;
