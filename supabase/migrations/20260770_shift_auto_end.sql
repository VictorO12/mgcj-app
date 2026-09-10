-- Shift auto-end — the privacy stop for whole-shift background tracking.
--
-- Design: .claude/notes/background-location-shift-tracking.md (step 3)
--
-- Background location means the app keeps reporting a driver's position after
-- they pocket their phone. That is the point while they are working, and it is
-- indefensible after they have gone home. Until now the only thing that ever
-- turned a forgotten shift off was reap_stale_drivers at FOUR HOURS — a number
-- sized for dispatch tolerance back when a backgrounded app emitted nothing at
-- all. With the background task running it would be four hours of following
-- someone home from work.
--
-- So tracking gets its own stop, shorter than and independent of the reaper:
-- 45 minutes of no sign of work -> ask; 15 more minutes of silence -> offline.
-- A working driver taps once. Nobody is ever ended without having been asked.

-- ─── 1. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE drivers
  -- Last sign this driver was WORKING, as opposed to merely online: going
  -- online, a ride changing state under them, or acknowledging the prompt.
  -- Movement is handled separately (see driver_has_moved below) because it is
  -- already recorded in driver_locations and does not need a second write.
  ADD COLUMN IF NOT EXISTS shift_activity_at timestamptz,
  -- When we asked "still on shift?". NULL means no question outstanding.
  ADD COLUMN IF NOT EXISTS shift_prompt_at   timestamptz;

-- driver_has_moved scans one driver's recent fixes; 20260768's index leads with
-- company_id, so it cannot serve this.
CREATE INDEX IF NOT EXISTS driver_locations_driver_recent_idx
  ON driver_locations (driver_id, recorded_at DESC);

-- ─── 2. Movement ────────────────────────────────────────────────────────────

-- Has this driver actually gone anywhere in the last N minutes?
--
-- This exists because ride events are NOT a complete picture of working. A
-- driver two hours into a run to Halifax has no status transitions for the
-- whole fare, and a driver taking street hails for cash has none at all — both
-- would look idle to a ride-event-only test and get switched off mid-fare.
--
-- Measured as the bounding box of their recorded fixes rather than "did any fix
-- arrive": the app's fallback heartbeat records a fix every 10s whether or not
-- the car has moved, so mere presence of rows proves nothing. ~0.002 degrees is
-- roughly 200m of latitude, and less of longitude at this latitude — imprecise
-- on purpose, since the question is "has this car plainly moved", not how far.
CREATE OR REPLACE FUNCTION public.driver_has_moved(
  p_driver_id uuid,
  p_minutes   int
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (max(lat) - min(lat)) > 0.002 OR (max(lng) - min(lng)) > 0.002,
    false
  )
    FROM driver_locations
   WHERE driver_id = p_driver_id
     AND recorded_at > now() - make_interval(mins => p_minutes);
$$;

-- ─── 3. Activity stamps ─────────────────────────────────────────────────────

-- Going online starts the clock. Without this a driver who has just come on
-- shift and not moved yet has no activity at all, and the very next cron tick
-- would ask them whether they are still on a shift they started five minutes
-- ago.
CREATE OR REPLACE FUNCTION public.stamp_shift_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active AND NOT COALESCE(OLD.is_active, false) THEN
    NEW.shift_activity_at := now();
    NEW.shift_prompt_at   := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_shift_start ON drivers;
CREATE TRIGGER trg_stamp_shift_start
  BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION public.stamp_shift_start();

-- A ride moving under a driver is proof of work.
CREATE OR REPLACE FUNCTION public.stamp_shift_activity_from_ride()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.driver_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE drivers
       SET shift_activity_at = now(),
           shift_prompt_at   = NULL
     WHERE id = NEW.driver_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_shift_activity ON rides;
CREATE TRIGGER trg_stamp_shift_activity
  AFTER UPDATE ON rides
  FOR EACH ROW EXECUTE FUNCTION public.stamp_shift_activity_from_ride();

-- ─── 4. The pass ────────────────────────────────────────────────────────────

-- Returns what it did, so the caller can push. Three statements, in this order,
-- deliberately NOT one:
--
--   RECOVER  clear a prompt for a driver who turned out to be working after all
--   PROMPT   ask drivers who look idle
--   END      switch off drivers who were asked and never answered
--
-- Collapsing prompt and end into one UPDATE races itself on the boundary: a
-- driver 60 minutes idle with no prompt outstanding satisfies both branches on
-- the same tick, and which wins is statement order. Requiring a non-null
-- shift_prompt_at older than the grace window is what guarantees nobody is ever
-- ended without having been asked first.
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
  -- RECOVER. A driver who moved after being asked is working; drop the
  -- question. Without this their shift_prompt_at stays set forever, and since
  -- PROMPT requires it to be NULL they could never be asked again.
  UPDATE drivers d
     SET shift_prompt_at = NULL
   WHERE d.is_active
     AND d.shift_prompt_at IS NOT NULL
     AND (
       public.driver_has_moved(d.id, prompt_minutes)
       OR d.shift_activity_at > now() - make_interval(mins => prompt_minutes)
     );

  RETURN QUERY
  WITH prompted AS (
    UPDATE drivers d
       SET shift_prompt_at = now()
     WHERE d.is_active
       AND d.shift_prompt_at IS NULL
       AND COALESCE(d.shift_activity_at, '-infinity'::timestamptz)
             < now() - make_interval(mins => prompt_minutes)
       AND NOT public.driver_has_moved(d.id, prompt_minutes)
       -- Never interrupt a fare. Same guard as reap_stale_drivers, and load
       -- bearing for the same reason: a long ride generates no status
       -- transitions, so the activity stamp alone would call it idle.
       AND NOT EXISTS (
         SELECT 1 FROM rides r
          WHERE r.driver_id = d.id
            AND r.status IN ('assigned', 'driver_arriving', 'in_progress')
       )
    RETURNING d.id, d.push_token
  )
  SELECT p.id, p.push_token, 'prompt'::text FROM prompted p;

  RETURN QUERY
  WITH ended AS (
    UPDATE drivers d
       SET is_active       = false,
           shift_prompt_at = NULL
     WHERE d.is_active
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
END;
$$;

-- ─── 5. Grants ──────────────────────────────────────────────────────────────
--
-- Supabase's default privileges grant EXECUTE on new functions directly to anon
-- and authenticated, and "REVOKE FROM public" does NOT remove those — they must
-- be named. Without this, any session holding the app's anon key could switch
-- every driver on the platform offline.

REVOKE EXECUTE ON FUNCTION public.run_shift_auto_end(int, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_shift_auto_end(int, int) TO service_role;

REVOKE EXECUTE ON FUNCTION public.driver_has_moved(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_moved(uuid, int) TO service_role;

-- No new cron job: this piggybacks scheduled-coverage-monitor's existing 10-min
-- pass, same as the reaper, so cron.job_run_details does not grow. 10-minute
-- resolution on a 45/15 minute rule is fine — the effect is that "45 minutes"
-- means 45-55.
