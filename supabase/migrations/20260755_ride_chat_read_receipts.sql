-- Seen receipts for the passenger <-> driver thread.
--
-- Two changes, both small, and both needed for "Seen" to mean anything:
--   1. a participant may read the OTHER participant's cursor, not just their own
--   2. cursor writes broadcast, so "Seen" appears while the thread is open
--      rather than on next fetch
--
-- The dispatch <-> driver thread needs no migration: driver_chat_state already
-- holds both cursors and its existing SELECT policy already lets both sides
-- read the row. That side is a UI change only.

-- ─── 1. Participants can read each other's cursors ──────────────────────────
-- Was: profile_id = auth.uid() AND is_ride_participant(ride_id) -- own row only,
-- which is exactly the row that is useless for a receipt. You need the other
-- person's.
--
-- Still gated on is_ride_participant, so this does not widen who can see the
-- ride: a cycled-out driver fails that check and reads nothing, same as before.
-- What a participant gains is a timestamp on a row whose profile_id they can
-- already infer from the thread itself, so the disclosure is "when did the
-- person I am talking to open this", which is the entire point of a receipt.
DROP POLICY IF EXISTS ride_chat_reads_select ON ride_chat_reads;
CREATE POLICY ride_chat_reads_select ON ride_chat_reads
  FOR SELECT TO authenticated
  USING (public.is_ride_participant(ride_id));

-- INSERT/UPDATE are unchanged and still own-row-only: reading someone's cursor
-- is a receipt, writing it would be forging one.

-- ─── 2. Broadcast cursor moves on the ride's existing topic ─────────────────
-- Same `ride:<id>` channel as the messages themselves, distinguished by event
-- name. One channel per ride rather than two: the subscriber is the same
-- client, the authorization is the same policy, and a second topic would need
-- its own entry in the realtime.messages policy for no gain.
CREATE OR REPLACE FUNCTION public.broadcast_ride_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'ride_id',      NEW.ride_id,
      'profile_id',   NEW.profile_id,
      'last_read_at', NEW.last_read_at
    ),
    'read_receipt',
    'ride:' || NEW.ride_id::text,
    true
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Same rule as broadcast_ride_message: a realtime outage must never roll
  -- back the write. A missed receipt is a stale "Delivered", which is a far
  -- smaller problem than a read cursor that failed to persist and makes the
  -- unread badge wrong on next open.
  RAISE WARNING 'broadcast_ride_read failed for ride %: %', NEW.ride_id, SQLERRM;
  RETURN NULL;
END;
$$;

-- INSERT *and* UPDATE: the first markRead of a thread inserts, every one after
-- it updates, and a receipt that only fired on the first would be worse than
-- none -- it would show "Seen" at the wrong time and then freeze.
CREATE TRIGGER broadcast_ride_read_trg
  AFTER INSERT OR UPDATE ON ride_chat_reads
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_ride_read();
