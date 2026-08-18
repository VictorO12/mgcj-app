-- G3 Phase 1 — Broadcast authorization spike
--
-- WHAT THIS IS FOR
-- ride_messages uses Supabase Broadcast (a DB trigger calling realtime.send()
-- into a private channel) instead of postgres_changes, so that the highest-
-- write table in the system is not added to the supabase_realtime publication
-- alongside `rides`. See section 6 of 20260754_ride_messages.sql.
--
-- The cost of that choice is that authorization works differently. With
-- postgres_changes, the RLS policy on the table does the work. With Broadcast,
-- Realtime evaluates RLS on `realtime.messages`, keyed on the TOPIC NAME --
-- so the policy has to parse the ride id back out of a string like
-- `ride:9f3c...`. Two things have to be true for that to work, and neither is
-- true anywhere else in this repo:
--
--   (a) realtime.topic() exists in this project's realtime schema, and
--   (b) a SECURITY DEFINER helper in `public` is callable from inside that
--       policy, as the role Realtime evaluates as.
--
-- Steps 1 and 2 answer both in about two minutes, BEFORE section 7 of the
-- migration is applied. Step 3 needs a device and can wait for the UI.
--
-- If step 1 fails, the fallback is postgres_changes with a ride_id=eq.X
-- filter. Phase 1's shape does not change -- one module swaps -- but that
-- fallback means ALTER PUBLICATION on ride_messages, which is the thing
-- section 6 rejects. That is a decision for Victor, not an automatic swap.
-- Worth knowing: the premise behind rejecting it (that the publication's
-- single ordering thread is SHARED across tables) is marked "inferred, not
-- verified" in the design doc. It may cost less than feared.


-- ═══════════════════════════════════════════════════════════════════════
-- ORDER OF OPERATIONS — query 2 will fail if you run it out of turn
-- ═══════════════════════════════════════════════════════════════════════
--   1. Run query 1.                              (needs nothing applied)
--   2. Apply SECTIONS 1-6 of 20260754_ride_messages.sql.
--   3. Run query 2.                              (tests what step 2 created)
--   4. Apply SECTION 7 of the migration          (only if query 1 passed).
--   5. Create the Database Webhook by hand.      (see step 4 below)
--   6. Run step 3 from a device.
--
-- Running query 2 before step 2 gives
--   ERROR 42883: function public.ride_participant_role(unknown) does not exist
-- which means "not applied yet", NOT "the design is wrong".


-- ═══════════════════════════════════════════════════════════════════════
-- 1. Does realtime.topic() exist, and what is its signature?
--    RESULT 2026-08-18: PASS.
--      send  | payload jsonb, event text, topic text, private boolean
--      topic | (no arguments)
--    Both present, and `send`'s 4 positional args are exactly what
--    broadcast_ride_message() passes. `topic()` taking no arguments is what
--    the realtime.messages policy needs. Broadcast is viable here; the
--    postgres_changes fallback is NOT required, so section 7 can be applied
--    and ride_messages stays out of the supabase_realtime publication.
-- ═══════════════════════════════════════════════════════════════════════
-- Verifying in pg_proc rather than in the docs, per
-- migration-files-are-not-applied-state.
--
-- EXPECT: a `topic` row taking 0 args, and a `send` row taking 4
-- (payload jsonb, event text, topic text, private boolean).
-- If `topic` is missing        -> policy cannot key on the topic; see fallback above.
-- If `send` is missing         -> the broadcast trigger in section 6 will warn
--                                 on every insert and no message ever arrives.
-- If `send` takes 3 args       -> drop the trailing `true` in the trigger.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
 WHERE p.pronamespace = 'realtime'::regnamespace
   AND p.proname IN ('topic', 'send')
 ORDER BY p.proname;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. Is the participation helper callable as `authenticated`?
-- ═══════════════════════════════════════════════════════════════════════
-- This is independent of Realtime entirely -- it is the other half of the
-- question, and it is worth knowing separately, because a failure here would
-- also break the ordinary table policies, not just the broadcast channel.
--
-- RUN AFTER SECTIONS 1-6 OF 20260754_ride_messages.sql ARE APPLIED. Before
-- that it can only fail, and it fails as "function does not exist".
-- Substitute a real ride uuid and that ride's passenger or driver profile id.
-- Use a ride that is CURRENTLY LIVE (assigned/driver_arriving/in_progress) or
-- completed within 2h, or accepts_messages returns false correctly and looks
-- like a failure.
BEGIN;
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub', '<A REAL PASSENGER OR DRIVER UUID>',
                                      'role', 'authenticated')::text,
                    true);
  SET LOCAL ROLE authenticated;

  -- EXPECT: 'passenger' or 'driver', and true.
  -- NULL/false means auth.uid() is not resolving, or that profile is not on
  -- that ride -- check which before blaming the policy.
  -- Casts are explicit on purpose: a bare literal is `unknown`, and an
  -- unknown-argument failure reads identically to the function being absent.
  SELECT public.ride_participant_role('<A REAL RIDE UUID>'::uuid)  AS my_role,
         public.is_ride_participant('<A REAL RIDE UUID>'::uuid)    AS is_participant,
         public.ride_accepts_messages('<A REAL RIDE UUID>'::uuid)  AS accepts_messages;

  -- And the topic-parsing wrapper the policy actually calls. The two false
  -- cases matter as much as the true one: a malformed topic must return false,
  -- not raise, or policy evaluation errors out for everyone.
  SELECT public.can_read_ride_topic('ride:<A REAL RIDE UUID>') AS should_be_true,
         public.can_read_ride_topic('ride:not-a-uuid')         AS should_be_false,
         public.can_read_ride_topic('lobby:1')                 AS should_be_false_too;
ROLLBACK;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. End-to-end, from a device (needs the Phase 1 UI)
-- ═══════════════════════════════════════════════════════════════════════
-- Subscribe to `ride:<id>` with { config: { private: true } } from Expo Go as
-- the passenger, then insert a message as the driver and watch it arrive.
--
-- The failure mode to watch for is SILENT: an unauthorized private channel
-- does not error, it simply never delivers. So check the subscribe callback's
-- status -- CHANNEL_ERROR means the policy rejected, SUBSCRIBED with no
-- messages means the trigger is not firing (check for the RAISE WARNING from
-- broadcast_ride_message in the Postgres logs).
--
-- If SUBSCRIBED but nothing arrives and the trigger IS firing, try:
--   GRANT SELECT ON realtime.messages TO authenticated;
-- A missing grant here is a common miss and presents exactly as "no messages"
-- rather than as an error.
SELECT id, ride_id, sender_role, body, created_at
  FROM ride_messages
 WHERE ride_id = '<A REAL RIDE UUID>'
 ORDER BY created_at;
