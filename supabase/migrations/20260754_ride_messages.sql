-- G3 Phase 1 — passenger <-> driver in-ride chat.
--
-- Ride-scoped, not a persistent thread: a passenger/driver relationship exists
-- only for the duration of one ride and must not accumulate history across
-- rides the way driver_chat_messages (dispatch <-> driver) does.
--
-- Design doc: .claude/notes/G3-ride-communications-design.md
-- Deliberate departures from the driver_chat_messages shape are marked DIFFERS.

-- ─── 1. Tables ──────────────────────────────────────────────────────────────

CREATE TABLE ride_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id),
  -- DIFFERS from driver_chat_messages.sender_id (NOT NULL, no ON DELETE):
  -- delete-account nulls passenger_id on rides/ride_reviews and then DELETEs
  -- the profiles row (delete-account/index.ts:64-65). A NOT NULL FK here would
  -- raise a violation and break passenger self-deletion -- a shipped, working
  -- flow -- the first time this table holds a row for a deleting passenger.
  -- sender_role carries the attribution needed to render the thread, so the id
  -- is not required after the fact. driver_chat_messages escapes this only
  -- because drivers never self-delete; do not copy its shape.
  sender_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- 'admin'/'dispatcher' are admitted from day one though nothing writes them
  -- yet (D5, a possible dispatch<->passenger leg). Widening a CHECK later is
  -- another hand-applied migration, and this repo's history says those get
  -- believed-but-not-applied. Two words now beat an ALTER later.
  sender_role text NOT NULL CHECK (sender_role IN ('passenger','driver','admin','dispatcher')),
  body        text NOT NULL,
  -- Distinguishes a tapped quick reply / thumbs-up ack from typed text. Cheap
  -- now, and it is what makes "the driver never typed while moving" auditable.
  kind        text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','quick_reply','ack')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only access pattern: one thread, in order.
CREATE INDEX ride_messages_thread_idx ON ride_messages (ride_id, created_at);

-- Read cursor -- NOT a participant list. Authority on who is in the thread
-- stays is_ride_participant() reading rides live. There is deliberately no
-- role column: role is derivable from rides.passenger_id/driver_id, and
-- storing it duplicates state that can drift.
--
-- DIFFERS from driver_chat_state's two hardcoded columns
-- (last_read_by_driver_at / last_read_by_admin_at), which is the shape that
-- does not extend. One row per reader does -- which is what makes D5 free: an
-- admin opening the thread just gets a row, no schema change. It also removes
-- the contention of two parties upserting the same row.
CREATE TABLE ride_chat_reads (
  ride_id      uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL -- this is half the primary key. Deliberately
  -- different from ride_messages.sender_id above; do not copy the action across.
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT '1970-01-01',
  PRIMARY KEY (ride_id, profile_id)
);

-- ─── 2. Grants ──────────────────────────────────────────────────────────────
-- Tables created after 2026-10-30 are not reachable via PostgREST without these.
--
-- No UPDATE or DELETE on ride_messages, on purpose: immutability falls out of
-- the missing grant, so unlike the fare columns this needs no guard trigger.
GRANT SELECT, INSERT ON ride_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON ride_chat_reads TO authenticated;

-- ─── 3. Participation helper ────────────────────────────────────────────────
-- SECURITY DEFINER plpgsql, not a raw cross-table subquery from ride_messages
-- into rides -- that subquery is the 42P17 recursion shape this project has
-- already been bitten by twice (see 20260715_inline_staff_check_in_rls.sql).
--
-- Returns the caller's role ON THIS RIDE, or NULL if they are not on it. The
-- role-returning form is what lets the INSERT policy verify sender_role
-- against the ride instead of trusting the client's self-assertion.
CREATE OR REPLACE FUNCTION public.ride_participant_role(p_ride_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT CASE
           WHEN r.passenger_id = auth.uid() THEN 'passenger'
           WHEN r.driver_id    = auth.uid() THEN 'driver'
           ELSE NULL
         END
    INTO v_role
    FROM rides r
   WHERE r.id = p_ride_id;

  RETURN v_role;
END;
$$;

-- Whether the ride is in a state that accepts new messages. A SEPARATE definer
-- helper rather than an EXISTS subquery inlined in the policy: an inlined
-- subquery evaluates under the CALLER's RLS on `rides`, which would make
-- passenger messaging silently depend on guests keeping SELECT on their own
-- ride. Tightening rides RLS later would then break chat with an opaque policy
-- error rather than an obvious one. Going through a definer bypasses that by
-- construction -- the same reason participation goes through one.
--
-- THIS FUNCTION IS THE AUTHORITY on the messaging window. There is exactly one
-- mirror of it, rideAcceptsMessages() in src/hooks/useRideThread.ts, which
-- exists so the composer can close with an explanation rather than bouncing an
-- insert off this policy. Postgres and React Native cannot share a module the
-- way the Deno functions share _shared/fare.ts, so two definitions is the
-- floor -- but two is also the ceiling. Anything server-side that needs this
-- rule calls this function; it does not restate the interval.
--
-- D4: the window stays open for 2 hours after completion. That is not
-- a nicety -- "I left my bag in the car" is the single most common reason a
-- passenger needs their driver after a ride, and closing the thread the
-- instant the driver taps complete sends every one of those to dispatch, or
-- to nobody. It also keeps this consistent with Phase 2, where the proxy
-- number is released on completion PLUS a grace window; a chat that dies at
-- zero while the phone line stays live for two hours is the odd half.
--
-- Keyed on completed_at, which is set once by set_ride_completed_at on the
-- transition into 'completed' and then frozen -- never updated_at, which any
-- later write to the row would move (see the ops_revenue misattribution).
-- Cancelled rides get no grace: there is no completed_at, and nothing to
-- have left in the car.
CREATE OR REPLACE FUNCTION public.ride_accepts_messages(p_ride_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_status       text;
  v_completed_at timestamptz;
BEGIN
  SELECT status, completed_at INTO v_status, v_completed_at
    FROM rides WHERE id = p_ride_id;

  IF v_status IN ('assigned','driver_arriving','in_progress') THEN
    RETURN true;
  END IF;

  RETURN v_status = 'completed'
     AND v_completed_at IS NOT NULL
     AND v_completed_at > now() - interval '2 hours';
END;
$$;

CREATE OR REPLACE FUNCTION public.is_ride_participant(p_ride_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN public.ride_participant_role(p_ride_id) IS NOT NULL;
END;
$$;

-- UNLIKE reap_stale_drivers, these MUST be executable by `authenticated`, and
-- the revoke-from-anon/authenticated pattern must NOT be applied here:
-- anonymous guest bookers sign in via signInAnonymously() and resolve to role
-- `authenticated`, so that grant is exactly what covers them. Guests are a
-- real population -- this is why authority is the rides row and not
-- company_id, which a guest does not meaningfully have.
GRANT EXECUTE ON FUNCTION public.ride_participant_role(uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_ride_participant(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_accepts_messages(uuid) TO authenticated;

-- ─── 4. company_id is stamped, never client-set ─────────────────────────────
CREATE OR REPLACE FUNCTION public.stamp_ride_message_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT company_id INTO NEW.company_id FROM rides WHERE id = NEW.ride_id;
  IF NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'ride % has no company_id', NEW.ride_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_ride_message_company_trg
  BEFORE INSERT ON ride_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_ride_message_company();

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE ride_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_chat_reads ENABLE ROW LEVEL SECURITY;

-- SELECT is never gated on STATUS. Putting status into this policy would make
-- the thread vanish under both parties the instant the driver taps complete --
-- and the thread is the evidence when the ride is later disputed.
--
-- But "open forever" is the wrong words, and worth being precise about:
-- participation is derived from the LIVE rides row, so access follows
-- rides.driver_id. Driver cycling is routine here (a 60s non-response
-- reassigns), and the moment a ride is cycled from driver A to driver B, A
-- loses read access to the thread. That is the right privacy default and it
-- falls out of the design rather than needing its own rule -- but do not
-- describe this policy as permanent access, because for a cycled driver it is
-- not.
--
-- Driver B, conversely, DOES see A's earlier exchange: the policy is
-- ride-scoped, so it returns the whole thread with no assignment-window
-- filtering. That is deliberate -- it is context the new driver needs. It
-- lands a requirement on the UI, not here: message ownership must be derived
-- from sender_id and never from sender_role, or B sees A's messages in B's own
-- bubble. See driverChangeIndices() in RideChatScreen.
CREATE POLICY ride_messages_select ON ride_messages
  FOR SELECT TO authenticated
  USING (public.is_ride_participant(ride_id));

-- D1 = yes. Shipped in this migration even though no dashboard UI exists yet,
-- because adding a policy later is another hand-applied migration and dispatch
-- needs the thread when adjudicating a complaint. is_staff() (admin OR
-- dispatcher) rather than role = 'admin': dispatchers do ride ops, so they are
-- precisely the staff who need it. Read-only -- no staff INSERT policy until
-- D5 is decided.
CREATE POLICY ride_messages_select_staff ON ride_messages
  FOR SELECT TO authenticated
  USING (is_staff() AND company_id = get_my_company_id());

-- INSERT gated on the ride being live. 'assigned' implies the driver has
-- accepted: assign-ride only ever writes 'offered' (index.ts:484), and all
-- four writers of 'assigned' set confirmed_by_driver in the SAME statement
-- (AssignedRideScreen.tsx:81, AssignedRidesListScreen.tsx:341,
-- DriverApp.tsx:545 and :589), while dispatch-assign-ride writes
-- 'offered'/'scheduled' with confirmed_by_driver: false (index.ts:113-114).
-- So no separate confirmed_by_driver check is needed here.
-- RE-VERIFY THIS LIST if anyone adds a new writer of 'assigned' -- if one
-- lands without confirmed_by_driver, this policy lets a passenger message a
-- driver who has not accepted the ride.
--
-- sender_role is checked against the ride, never self-asserted. Without the
-- ride_participant_role() equality a passenger could post as the driver --
-- the same bug class 20260702_driver_chat_tenant_fix.sql had to fix.
CREATE POLICY ride_messages_insert ON ride_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND sender_role = public.ride_participant_role(ride_id)
    AND public.ride_accepts_messages(ride_id)
  );

-- Read cursor: a participant owns exactly their own row.
CREATE POLICY ride_chat_reads_select ON ride_chat_reads
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid() AND public.is_ride_participant(ride_id));

CREATE POLICY ride_chat_reads_insert ON ride_chat_reads
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid() AND public.is_ride_participant(ride_id));

CREATE POLICY ride_chat_reads_update ON ride_chat_reads
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- ─── 6. Realtime: Broadcast, NOT postgres_changes ───────────────────────────
-- Deliberately NOT `ALTER PUBLICATION supabase_realtime ADD TABLE
-- ride_messages`. Postgres Changes are processed on a single thread to
-- preserve order; whether that thread is shared across every table in the
-- publication is inferred, not confirmed. If it is, adding the highest-write
-- table in the system to a publication that already carries `rides` means chat
-- inserts contend with the ride status changes that dispatch and passenger
-- tracking depend on -- head-of-line blocking on the most latency-critical
-- path we have. Broadcast sidesteps the question entirely.
--
-- Note this is NOT the fan-out argument: a ride thread has exactly two
-- participants, so Supabase's ~3,000-concurrent-subscriber threshold is
-- irrelevant here. driver_chat_messages stays on postgres_changes -- it is
-- low-volume and works, and there is no reason to churn it.
CREATE OR REPLACE FUNCTION public.broadcast_ride_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',          NEW.id,
      'ride_id',     NEW.ride_id,
      'sender_id',   NEW.sender_id,
      'sender_role', NEW.sender_role,
      'body',        NEW.body,
      'kind',        NEW.kind,
      'created_at',  NEW.created_at
    ),
    'new_message',
    'ride:' || NEW.ride_id::text,
    true   -- private channel; authorized by the realtime.messages policy below
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A realtime outage must never roll back the message itself. The thread is
  -- the durable record; the broadcast is only how the other phone hears about
  -- it sooner than its next fetch.
  RAISE WARNING 'broadcast_ride_message failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

CREATE TRIGGER broadcast_ride_message_trg
  AFTER INSERT ON ride_messages
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_ride_message();

-- Authorization for the private channel. Realtime evaluates RLS on
-- realtime.messages, keyed on the topic name, so the ride id has to be parsed
-- back out of the topic. That parse is wrapped in a function rather than
-- inlined as a cast in the policy: a malformed topic would otherwise raise
-- invalid_text_representation from inside policy evaluation, and AND is not
-- guaranteed to short-circuit left to right.
CREATE OR REPLACE FUNCTION public.can_read_ride_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_ride_id uuid;
BEGIN
  IF p_topic IS NULL OR split_part(p_topic, ':', 1) <> 'ride' THEN
    RETURN false;
  END IF;

  BEGIN
    v_ride_id := split_part(p_topic, ':', 2)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN public.is_ride_participant(v_ride_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_read_ride_topic(text) TO authenticated;

-- ─── 7. Realtime authorization policy — APPLY LAST, AFTER THE SPIKE ─────────
-- This is the one part of this migration with no precedent in the repo, and
-- the only part that can fail on an assumption rather than a typo. It depends
-- on realtime.topic() existing in THIS project's realtime schema -- verify
-- with .claude/notes/g3-broadcast-auth-spike.sql before running it, per the
-- migration-files-are-not-applied-state rule.
--
-- If realtime.topic() is absent, do NOT silently fall back to
-- postgres_changes: that means ALTER PUBLICATION on the highest-write table in
-- the system, which is exactly what section 6 above rejects. It is a decision,
-- not a swap.
CREATE POLICY ride_thread_broadcast_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND public.can_read_ride_topic(realtime.topic())
  );
