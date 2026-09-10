-- Post-apply checks for 20260770_shift_auto_end.sql.
-- Run in the Supabase SQL editor after applying, BEFORE redeploying
-- scheduled-coverage-monitor (which starts calling run_shift_auto_end).

-- 1. Columns exist on drivers. Expect two rows, both timestamptz, both nullable.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'drivers'
   AND column_name IN ('shift_activity_at', 'shift_prompt_at');

-- 2. Triggers installed. Expect trg_stamp_shift_start on drivers (BEFORE UPDATE)
--    and trg_stamp_shift_activity on rides (AFTER UPDATE).
SELECT event_object_table, trigger_name, action_timing, event_manipulation
  FROM information_schema.triggers
 WHERE trigger_name IN ('trg_stamp_shift_start', 'trg_stamp_shift_activity');

-- 3. Both functions are service-role only. Expect f, f, t on each row.
--    "REVOKE FROM public" alone does NOT strip the anon/authenticated grants
--    Supabase adds by default — they have to be named, and this project has
--    been bitten by that three times. Without it, anyone holding the app's
--    anon key could switch every driver on the platform offline.
SELECT 'run_shift_auto_end' AS fn,
       has_function_privilege('anon',          'public.run_shift_auto_end(int,int)', 'EXECUTE') AS anon,
       has_function_privilege('authenticated', 'public.run_shift_auto_end(int,int)', 'EXECUTE') AS authed,
       has_function_privilege('service_role',  'public.run_shift_auto_end(int,int)', 'EXECUTE') AS service
UNION ALL
SELECT 'driver_has_moved',
       has_function_privilege('anon',          'public.driver_has_moved(uuid,int)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.driver_has_moved(uuid,int)', 'EXECUTE'),
       has_function_privilege('service_role',  'public.driver_has_moved(uuid,int)', 'EXECUTE');

-- 4. The index the movement check needs (20260768's leads with company_id and
--    cannot serve a per-driver scan).
SELECT indexname FROM pg_indexes
 WHERE tablename = 'driver_locations'
   AND indexname = 'driver_locations_driver_recent_idx';

-- 5. DRY RUN — who would be prompted or ended right now? This CHANGES DATA, so
--    run it inside a transaction you roll back. Expect 0 rows on a fleet that
--    is either working or already offline; anything here should be a driver you
--    can explain.
BEGIN;
SELECT * FROM public.run_shift_auto_end();
ROLLBACK;

-- 6. Sanity on the movement test itself: for each online driver, has the
--    bounding box of their last 45 minutes of fixes moved? Compare against
--    where you know the cars actually are. `false` for a driver you know is
--    driving means the breadcrumb pipeline is not writing.
SELECT d.id,
       p.full_name,
       d.is_active,
       d.shift_activity_at,
       d.shift_prompt_at,
       public.driver_has_moved(d.id, 45) AS moved_45m,
       (SELECT count(*) FROM driver_locations dl
         WHERE dl.driver_id = d.id
           AND dl.recorded_at > now() - interval '45 minutes') AS fixes_45m
  FROM drivers d
  JOIN profiles p ON p.id = d.id
 WHERE d.is_active
 ORDER BY p.full_name;
