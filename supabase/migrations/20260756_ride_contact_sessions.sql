-- G3 Phase 2 — masked passenger <-> driver telephony (Twilio Proxy).
--
-- Design docs: .claude/notes/G3-ride-communications-design.md (§6, §7, §9)
--              .claude/notes/G3-phase2-masked-telephony-plan.md  <- §2 of that
--              file SUPERSEDES §6.2 of the parent, and this table follows it.
--
-- Phase 1 gave app-installed passengers a chat thread. It closed nothing about
-- number exposure: the four tel:/sms: call sites still hand each party the
-- other's real number, and a guest passenger with no app cannot be reached at
-- all. This table is the mapping that fixes both.
--
-- Twilio Proxy owns the number pool, the (caller, proxy) -> session routing and
-- the "one participant is never in two live sessions on one number" rule. We
-- own which ride a session belongs to, when it opens and closes, and the audit
-- record. Proxy availability on this account was VERIFIED in the console
-- 2026-08-18 (not assumed -- the parent doc had asserted it while its own cited
-- section said "unverified", and the schema forks on the answer).

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE ride_contact_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id                   uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  company_id                uuid REFERENCES companies(id),

  -- WHICH driver this session bridges. A ride changes drivers routinely here
  -- (assign-ride's two-pass cycling, dispatch-assign-ride, a released soft
  -- claim), and Twilio caps a session at two participants which CANNOT be
  -- updated -- swapping one means delete-then-create. So a driver change closes
  -- this session and opens a new one, giving one row per (ride, driver).
  -- That is not a workaround, it is the audit trail: "which driver could reach
  -- this passenger, between when and when" is precisely the dispute question,
  -- and a session mutated in place cannot answer it.
  driver_id                 uuid REFERENCES profiles(id) ON DELETE SET NULL,

  proxy_session_sid         text NOT NULL,   -- KC…
  passenger_participant_sid text,            -- KP…
  driver_participant_sid    text,            -- KP…

  -- The real numbers, stored deliberately. This table IS the audit record, and
  -- a dispute months later has to say which two numbers were bridged; Twilio's
  -- own retention is not ours to depend on. See the grants section for why
  -- storing them here is safe and why it dictates that no client may read this
  -- table.
  passenger_number          text NOT NULL,
  driver_number             text NOT NULL,

  -- TWO proxy numbers, not one. Twilio's Participant.proxy_identifier is "the
  -- number this participant dials to reach their partner" -- not their caller
  -- ID -- and it is a per-participant field. In a two-party session both sides
  -- usually land on the same number, and §6.2 of the parent doc modelled it as
  -- a single `proxy_number` on that basis. Storing what the API actually
  -- returns costs one column and removes an assumption we would otherwise
  -- discover was wrong in production, on a call that failed to connect.
  passenger_proxy_number    text,            -- what the PASSENGER dials
  driver_proxy_number       text,            -- what the DRIVER dials

  mode                      text NOT NULL DEFAULT 'voice-and-message'
                              CHECK (mode IN ('voice-and-message','voice-only','message-only')),

  allocated_at              timestamptz NOT NULL DEFAULT now(),

  -- When Twilio will close this session of its own accord. Set at completion to
  -- completed_at + ride_contact_grace(), and pushed to Twilio as the session's
  -- DateExpiry so TWILIO holds the timer, not us.
  --
  -- This is a separate column from released_at rather than a future-dated
  -- released_at, because "stopped being usable at 14:05" and "will stop being
  -- usable at 14:05" are different facts and collapsing them makes every reader
  -- of released_at ask which one it is. Live means:
  --     released_at IS NULL AND (expires_at IS NULL OR expires_at > now())
  expires_at                timestamptz,

  released_at               timestamptz,     -- non-NULL = closed by US, and why
  closed_reason             text,

  -- Interaction metadata, METADATA ONLY. §6.4: we never record calls. Two-party
  -- consent rules vary by province, Twilio's own Proxy docs tell you to consult
  -- counsel, Uber doesn't record either, and the compliance surface would dwarf
  -- the feature. This is deliberate and permanent -- do not "improve" it.
  --
  -- Counters on the session rather than a ride_contact_interactions table.
  -- That is a scope call, not an oversight: a per-interaction table answers
  -- "how long was the third call" and these columns do not, but it also brings
  -- its own retention question, and D3 (floor = the 120-day chargeback window,
  -- ceiling = the PIPEDA/lawyer answer) is still open. It is deferred to Phase 3
  -- alongside the retention cron, where the two get decided together instead of
  -- one being settled to unblock the other -- which is exactly the mistake D4
  -- records.
  voice_interactions        integer NOT NULL DEFAULT 0,
  sms_interactions          integer NOT NULL DEFAULT 0,
  last_interaction_at       timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- The only hot read: "is there a live session for this ride". Partial, because
-- released rows are audit weight that no request path ever scans.
CREATE INDEX ride_contact_sessions_live_idx
  ON ride_contact_sessions (ride_id) WHERE released_at IS NULL;

-- For the Twilio callback, which arrives knowing only the session SID.
CREATE INDEX ride_contact_sessions_sid_idx ON ride_contact_sessions (proxy_session_sid);

-- DELIBERATELY NO UNIQUE CONSTRAINT anywhere on this table, including the
-- tempting `unique (ride_id) where released_at is null`. Per §9 of the design
-- doc this table is built partition-ready, and a partitioned table's unique
-- constraints must include the partition key -- adding one now silently blocks
-- the conversion later. "One live session per ride" is an allocator invariant
-- (sync-ride-contact closes before it opens), not a schema one.

-- ─── 2. Grants — the important part ─────────────────────────────────────────
--
-- NO GRANTS TO `authenticated`. NONE. Not even SELECT to participants.
--
-- This is the single most important line in the migration, and it is the exact
-- trap this codebase has already paid for once: RLS GATES ROWS, NOT COLUMNS
-- (the $0.75 ride -- a passenger could UPDATE their own ride row because the
-- policy admitted the row, and the fare column rode along).
--
-- Every row here contains BOTH parties' real phone numbers. A "participants may
-- read their own session" policy would therefore hand the driver the
-- passenger's real number and vice versa -- delivering, through the front door,
-- the precise leak this entire feature exists to close. There is no column-level
-- policy that fixes it and no SELECT policy worth writing.
--
-- The ONLY reader is the `ride-contact` Edge Function, on the service role,
-- which is participant-gated and returns to each caller nothing but a proxy
-- number for their OWN side. Dispatch's view, if it ever wants one, goes
-- through a function too -- not a grant.
--
-- RLS is still enabled with no policies (deny-all) rather than left off: with
-- RLS off, a future GRANT added by someone reading the post-Oct-2026 grant
-- convention as an unconditional rule would open the table wide with nothing
-- standing in the way.
ALTER TABLE ride_contact_sessions ENABLE ROW LEVEL SECURITY;

-- ─── 3. company_id is stamped, never written by a caller ────────────────────
-- Same shape as stamp_ride_message_company. The service role writes this table,
-- so this is not a trust boundary -- it is a consistency one: the tenant of a
-- session is a fact about the ride, and deriving it removes the chance of a
-- future caller passing the wrong one into a tenant-scoped report.
CREATE OR REPLACE FUNCTION public.stamp_ride_contact_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT company_id INTO NEW.company_id FROM rides WHERE id = NEW.ride_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_ride_contact_company_trg
  BEFORE INSERT ON ride_contact_sessions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_ride_contact_company();

-- ─── 4. One definition of the grace window ──────────────────────────────────
--
-- D4 settled the post-completion window at 2 hours. It is currently written out
-- twice: ride_accepts_messages() (the authority) and rideAcceptsMessages() in
-- useRideThread.ts (the one permitted client mirror, because Postgres and React
-- Native cannot share a module).
--
-- Phase 2 needs the same number a third time, to set the Proxy session's
-- date_expiry so Twilio closes the phone line at the same moment the chat
-- composer closes. Typing `interval '2 hours'` again would make three
-- definitions, and Phase 1's own note says what that costs: they drift, and the
-- drift shows up as a phone line that outlives the thread -- a number still
-- reachable after the product says contact is over. That is a leak with a
-- plausible-looking cause, which is the worst kind.
--
-- So the interval is extracted to one function and the existing authority is
-- rewritten to call it. Same signature, same semantics -- ride_accepts_messages
-- keeps every property it had, including being keyed on the FROZEN completed_at
-- rather than updated_at, and cancelled rides still getting no grace.
CREATE OR REPLACE FUNCTION public.ride_contact_grace()
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$ SELECT interval '2 hours' $$;

COMMENT ON FUNCTION public.ride_contact_grace() IS
  'D4: how long after completion passengers and drivers can still reach each '
  'other, by chat AND by masked phone. The single SQL definition -- '
  'ride_accepts_messages() and the Phase 2 proxy expiry both read it. The only '
  'other copy anywhere is rideAcceptsMessages() in useRideThread.ts.';

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
     AND v_completed_at > now() - public.ride_contact_grace();
END;
$$;

-- ride_accepts_messages was already granted to authenticated by 20260754 and a
-- CREATE OR REPLACE preserves that. ride_contact_grace() is called from inside
-- a SECURITY DEFINER body and from the service role only -- no client needs it,
-- so it gets no grant beyond the default.

-- ─── 5. When the phone line should close ────────────────────────────────────
-- Read by sync-ride-contact to set the Twilio session's DateExpiry, so Twilio
-- itself enforces the window. No cron of ours to schedule, nothing new that can
-- 401 in silence the way the four gated jobs did.
--
-- Returns NULL when the ride is not in a state that has an end yet (still
-- live), and the completion instant itself for a cancelled ride -- which is
-- D4's "cancelled rides get no grace": no completed_at, and nothing to have
-- left in the car.
CREATE OR REPLACE FUNCTION public.ride_contact_expiry(p_ride_id uuid)
RETURNS timestamptz
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

  IF v_status = 'completed' AND v_completed_at IS NOT NULL THEN
    RETURN v_completed_at + public.ride_contact_grace();
  END IF;

  IF v_status = 'cancelled' THEN
    RETURN now();
  END IF;

  RETURN NULL;   -- ride still live: no expiry yet
END;
$$;
