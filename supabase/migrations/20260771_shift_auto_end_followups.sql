-- Two things the 20260770 dry run surfaced before it ever ran for real.
--
-- The check-5 dry run returned six drivers due to be prompted, and EVERY ONE
-- had push_token = NULL. Both problems live in that one result.

-- ─── 1. A driver we cannot ask must not be "ended for not answering" ────────
--
-- 20260770's promise is that nobody is switched off without being asked first.
-- For a driver with no push token that was never true: the prompt has nowhere
-- to go, they sit out the 15-minute grace in silence, and the end branch fires
-- on a question they never received.
--
-- The resolution is not to spare them. A driver with no push token cannot be
-- offered a ride either — assign-ride filters on push_token, and a ride offer
-- IS a push — so unreachable AND not moving is not a working shift by any
-- reading. They are ended DIRECTLY, with no pretence of a prompt, and they find
-- out the same way a reaped driver does: the app corrects their toggle next
-- time they open it. Leaving them alone would mean background location running
-- indefinitely for someone who revoked notifications, which is precisely the
-- exposure step 3 exists to close.
--
-- It is reported as its own action so the logs never claim we asked.

-- ─── 2. Seeded demo drivers get an explicit flag ────────────────────────────
--
-- The six are the seeded demo drivers kept in the database for map realism.
-- They are online, tokenless, and have never moved, so they are exactly the
-- population both rules above target — they would have gone offline within the
-- hour and vanished from the dispatch map, possibly mid-pitch.
--
-- Until now their survival depended on an ACCIDENT: presence.ts treats
-- last_seen_at IS NULL as live, a tolerance that exists for a completely
-- unrelated reason (app builds predating the heartbeat, during a non-atomic
-- store rollout). Every new rule about idle drivers has to rediscover that
-- coupling, and the rollout note has flagged it as fragile for weeks. A flag
-- says what is actually meant, and survives the day the NULL tolerance is
-- tightened.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN drivers.is_demo IS
  'Seeded demo driver kept for map realism in pitches. Exempt from shift '
  'auto-end and the stale-driver reaper: they are permanently online, never '
  'move and hold no push token, which every idle-driver rule reads as an '
  'abandoned shift. Never set this on a real driver — it opts them out of '
  'every automatic offline sweep.';

-- ─── 3. The pass, with both changes ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.run_shift_auto_end(
  prompt_minutes int DEFAULT 45,
  grace_minutes  int DEFAULT 15
)
RETURNS TABLE (driver_id uuid, push_token text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- RECOVER: a driver who turned out to be working keeps their shift.
  UPDATE drivers d
     SET shift_prompt_at = NULL
   WHERE d.is_active
     AND d.shift_prompt_at IS NOT NULL
     AND (
       public.driver_has_moved(d.id, prompt_minutes)
       OR d.shift_activity_at > now() - make_interval(mins => prompt_minutes)
     );

  -- PROMPT: only drivers we can actually reach.
  RETURN QUERY
  WITH prompted AS (
    UPDATE drivers d
       SET shift_prompt_at = now()
     WHERE d.is_active
       AND NOT d.is_demo
       AND d.push_token IS NOT NULL
       AND d.shift_prompt_at IS NULL
       AND COALESCE(d.shift_activity_at, '-infinity'::timestamptz)
             < now() - make_interval(mins => prompt_minutes)
       AND NOT public.driver_has_moved(d.id, prompt_minutes)
       AND NOT EXISTS (
         SELECT 1 FROM rides r
          WHERE r.driver_id = d.id
            AND r.status IN ('assigned', 'driver_arriving', 'in_progress')
       )
    RETURNING d.id, d.push_token
  )
  SELECT p.id, p.push_token, 'prompt'::text FROM prompted p;

  -- END: asked, and never answered.
  RETURN QUERY
  WITH ended AS (
    UPDATE drivers d
       SET is_active       = false,
           shift_prompt_at = NULL
     WHERE d.is_active
       AND NOT d.is_demo
       AND d.shift_prompt_at IS NOT NULL
       AND d.shift_prompt_at < now() - make_interval(mins => grace_minutes)
       AND NOT public.driver_has_moved(d.id, prompt_minutes)
       AND NOT EXISTS (
         SELECT 1 FROM rides r
          WHERE r.driver_id = d.id
            AND r.status IN ('assigned', 'driver_arriving', 'in_progress')
       )
    RETURNING d.id, d.push_token
  )
  SELECT e.id, e.push_token, 'ended'::text FROM ended e;

  -- END UNREACHABLE: no token, so no question was ever possible. Same idle
  -- test, no grace window — a grace period only means something to someone who
  -- was asked. Distinct action name so a log line never claims otherwise.
  RETURN QUERY
  WITH ended_unreachable AS (
    UPDATE drivers d
       SET is_active       = false,
           shift_prompt_at = NULL
     WHERE d.is_active
       AND NOT d.is_demo
       AND d.push_token IS NULL
       AND COALESCE(d.shift_activity_at, '-infinity'::timestamptz)
             < now() - make_interval(mins => prompt_minutes)
       AND NOT public.driver_has_moved(d.id, prompt_minutes)
       AND NOT EXISTS (
         SELECT 1 FROM rides r
          WHERE r.driver_id = d.id
            AND r.status IN ('assigned', 'driver_arriving', 'in_progress')
       )
    RETURNING d.id, d.push_token
  )
  SELECT u.id, u.push_token, 'ended_unreachable'::text FROM ended_unreachable u;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.run_shift_auto_end(int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_shift_auto_end(int, int) TO service_role;

-- ─── 4. The reaper skips demo drivers too ───────────────────────────────────
--
-- Today they are spared by `last_seen_at is not null`, since they have never
-- heartbeated. That is the accidental coupling described above: the moment the
-- NULL tolerance is tightened — which the rollout plan says to do once the
-- heartbeat build is universal — the reaper would take them. Body otherwise
-- byte-for-byte 20260766's.

CREATE OR REPLACE FUNCTION public.reap_stale_drivers(stale_minutes int DEFAULT 240)
RETURNS TABLE (driver_id uuid, push_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
begin
  return query
  update public.drivers d
     set is_active = false
   where d.is_active = true
     and not d.is_demo
     and d.last_seen_at is not null
     and d.last_seen_at < now() - make_interval(mins => stale_minutes)
     and not exists (
       select 1 from public.rides r
        where r.driver_id = d.id
          and r.status in ('assigned', 'driver_arriving', 'in_progress')
     )
  returning d.id, d.push_token;
end;
$$;

-- MUST follow every CREATE OR REPLACE, not just a first CREATE: privileges are
-- re-evaluated, and Supabase's default privileges grant EXECUTE straight to
-- anon and authenticated. Revoking from PUBLIC alone leaves both intact.
REVOKE EXECUTE ON FUNCTION public.reap_stale_drivers(int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stale_drivers(int) TO service_role;

-- ─── 5. Flag the demo drivers ───────────────────────────────────────────────
--
-- NOT run here on purpose. The six ids from the dry run are IDENTIFIED, not
-- verified — setting is_demo on a real driver opts them out of every automatic
-- offline sweep, silently and permanently. Confirm with the identify query in
-- .claude/notes/shift-auto-end-postapply-checks.sql, then run the UPDATE there.
