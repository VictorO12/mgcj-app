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
--    (profiles has `name`, not `full_name`.)
SELECT d.id,
       p.name,
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


-- ═══ 20260771 follow-ups ════════════════════════════════════════════════════
--
-- The first dry run (check 5) returned six drivers due to be prompted, ALL with
-- push_token = NULL. That exposed two things, both fixed in 20260771: a driver
-- with no token was going to be "ended for not answering" a question that could
-- never be delivered, and the six were the seeded demo drivers, which until now
-- survived only because presence.ts treats a NULL last_seen_at as live.

-- 7. IDENTIFY. Confirm which online drivers are the seeded demo fleet before
--    flagging anything. A real driver looks different: rides > 0, crumbs
--    accumulating, a token unless they revoked notifications.
SELECT d.id, p.name, d.is_active, d.is_demo,
       d.push_token IS NULL AS no_token,
       d.last_seen_at, d.shift_activity_at,
       (SELECT count(*) FROM driver_locations dl WHERE dl.driver_id = d.id) AS crumbs,
       (SELECT count(*) FROM rides r WHERE r.driver_id = d.id)              AS rides
  FROM drivers d JOIN profiles p ON p.id = d.id
 WHERE d.is_active
 ORDER BY p.name;

-- 8. FLAG them, once identified. Paste the confirmed ids — do NOT flag by
--    "push_token IS NULL", which would also catch a real driver who revoked
--    notifications and opt them out of every automatic offline sweep forever.
-- UPDATE drivers SET is_demo = true WHERE id IN (
--   '00e60bc0-775a-46c4-af97-2a592d138a9e',
--   '0dd989b4-1f31-48a6-878b-a32d686afcab',
--   '25b40ac8-a6a6-47c9-9557-27ddc6ba9cb4',
--   'd884feee-456a-4231-9404-c528528fd108',
--   'bafdcad5-e3ed-489d-8691-697d071f63c0',
--   'f869c10f-ada0-4430-819e-63fa3cdbdd09'
-- );

-- 9. RE-RUN the dry run. After flagging, expect ZERO rows: the demo fleet is
--    exempt and no real driver is idle. Any row left is a real finding.
BEGIN;
SELECT * FROM public.run_shift_auto_end();
ROLLBACK;

-- 10. Both functions still service-role only after 20260771's CREATE OR REPLACE
--     (a replace re-evaluates privileges — this is the step that gets skipped).
--     Expect f, f, t on both rows.
SELECT 'run_shift_auto_end' AS fn,
       has_function_privilege('anon',          'public.run_shift_auto_end(int,int)', 'EXECUTE') AS anon,
       has_function_privilege('authenticated', 'public.run_shift_auto_end(int,int)', 'EXECUTE') AS authed,
       has_function_privilege('service_role',  'public.run_shift_auto_end(int,int)', 'EXECUTE') AS service
UNION ALL
SELECT 'reap_stale_drivers',
       has_function_privilege('anon',          'public.reap_stale_drivers(int)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.reap_stale_drivers(int)', 'EXECUTE'),
       has_function_privilege('service_role',  'public.reap_stale_drivers(int)', 'EXECUTE');
