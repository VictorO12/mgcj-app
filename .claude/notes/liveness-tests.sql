-- Driver-liveness live test. Paste into the Supabase SQL editor and Run.
--
-- TEST 1: reap_stale_drivers() must NEVER reap a driver on an active ride.
-- The heartbeat feeds passenger ETA during a fare, so a tunnel or a brief
-- signal drop must not flip the driver offline and null their location
-- mid-ride. The control half checks the reaper still does its actual job --
-- without it, an inert reaper would "pass" the first half for the wrong reason.
--
-- Reports through RAISE EXCEPTION, deliberately. The Supabase SQL editor does
-- NOT display RAISE NOTICE output, so a notice-based version shows a blank
-- pane whether it passed or failed. An exception is the one channel the editor
-- always shows -- and it doubles as the rollback guarantee: a DO block runs in
-- an implicit transaction, so raising at the end discards every write below,
-- including on the pass path. Nothing here persists, and no BEGIN/ROLLBACK is
-- needed. THE RED ERROR BOX IS THE RESULT, not a failure.

DO $$
DECLARE
  d_mid       uuid;
  d_idle      uuid;
  r_id        uuid;
  repurposed  boolean := false;
  reaped      integer;
  mid_active  boolean;
  idle_active boolean;
  verdict     text;
BEGIN
  -- Prefer a driver genuinely mid-ride, so no ride row is touched at all.
  SELECT r.driver_id INTO d_mid
    FROM rides r
   WHERE r.status IN ('assigned','driver_arriving','in_progress')
     AND r.driver_id IS NOT NULL
   LIMIT 1;

  -- Otherwise repurpose one ride row for the life of this transaction.
  IF d_mid IS NULL THEN
    SELECT id INTO d_mid FROM drivers ORDER BY id LIMIT 1;
    SELECT id INTO r_id  FROM rides ORDER BY created_at DESC LIMIT 1;
    IF d_mid IS NULL OR r_id IS NULL THEN
      RAISE EXCEPTION 'SETUP: need at least one driver and one ride row';
    END IF;
    UPDATE rides SET driver_id = d_mid, status = 'in_progress' WHERE id = r_id;
    repurposed := true;
  END IF;

  -- Control: a driver with NO active ride.
  SELECT d.id INTO d_idle
    FROM drivers d
   WHERE d.id <> d_mid
     AND NOT EXISTS (
       SELECT 1 FROM rides r
        WHERE r.driver_id = d.id
          AND r.status IN ('assigned','driver_arriving','in_progress'))
   LIMIT 1;

  IF d_idle IS NULL THEN
    RAISE EXCEPTION 'SETUP: need a second driver with no active ride';
  END IF;

  -- Both online, both 10 min stale (threshold is 5). Only the active-ride
  -- guard should be able to tell them apart.
  UPDATE drivers
     SET is_active = true, last_seen_at = now() - interval '10 minutes'
   WHERE id IN (d_mid, d_idle);

  SELECT public.reap_stale_drivers(5) INTO reaped;

  SELECT is_active INTO mid_active  FROM drivers WHERE id = d_mid;
  SELECT is_active INTO idle_active FROM drivers WHERE id = d_idle;

  verdict := CASE
    WHEN mid_active  IS NOT TRUE  THEN 'FAIL - a driver on an active ride was REAPED'
    WHEN idle_active IS NOT FALSE THEN 'FAIL - a stale idle driver was NOT reaped (reaper inert?)'
    ELSE 'PASS - mid-ride driver protected, stale idle driver reaped'
  END;

  RAISE EXCEPTION E'=== TEST 1 RESULT (rolled back, nothing changed) ===\n%\nreaped=%  mid_ride_still_active=%  idle_still_active=%  repurposed_ride=%',
    verdict, reaped, mid_active, idle_active, repurposed;
END $$;

-- RESULT 2026-08-23 -- PASS, on the preview build that activated the heartbeat:
--   PASS - mid-ride driver protected, stale idle driver reaped
--   reaped=1  mid_ride_still_active=t  idle_still_active=f  repurposed_ride=t
-- Both halves matter: reaped=1 with idle_still_active=f proves the reaper was
-- actually running, so mid_ride_still_active=t is the guard working rather than
-- a no-op. repurposed_ride=t means no driver was genuinely mid-ride at the time,
-- so a ride row was borrowed and rolled back.
--
-- Expected error text:
--   === TEST 1 RESULT (rolled back, nothing changed) ===
--   PASS - mid-ride driver protected, stale idle driver reaped
--   reaped=1  mid_ride_still_active=t  idle_still_active=f  repurposed_ride=f
