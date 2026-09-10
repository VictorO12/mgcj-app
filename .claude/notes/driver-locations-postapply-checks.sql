-- Post-apply checks for 20260768_driver_locations.sql.
-- Run in the Supabase SQL editor AFTER applying the migration and BEFORE any
-- app build writes breadcrumbs: a client hitting a table that doesn't exist
-- gets a permanent PostgREST error, and the uploader drops that batch.
-- A migration file in the repo is NOT proof the SQL ran.

-- 1. Table + columns. Expect 11 rows; recorded_at and received_at both present.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'driver_locations'
 ORDER BY ordinal_position;

-- 2. Policies. Expect exactly three: insert, select_own, select_staff.
SELECT policyname, cmd, qual, with_check
  FROM pg_policies
 WHERE tablename = 'driver_locations';

-- 3. RLS actually enabled (a table with policies and RLS off is wide open).
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'driver_locations';

-- 4. Grants. Expect SELECT + INSERT for authenticated and NOTHING for anon.
--
--    THIS FAILED ON FIRST RUN (2026-09-10) and 20260769 exists to fix it: both
--    roles held DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE,
--    because Supabase's ALTER DEFAULT PRIVILEGES grants ALL on every new table
--    and privileges are ADDITIVE — a narrower GRANT narrows nothing. Re-run
--    this check after applying 20260769. If a future table shows the same
--    thing, the fix is always revoke-then-regrant-a-list, never a tighter
--    GRANT.
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_name = 'driver_locations'
 ORDER BY grantee, privilege_type;

-- 5. The sequence grant, without which every client INSERT fails on nextval.
SELECT has_sequence_privilege('authenticated', 'driver_locations_id_seq', 'USAGE, SELECT');

-- 6. Prune function is service-role only. Supabase's default privileges grant
--    EXECUTE to anon/authenticated directly, and "REVOKE FROM public" does not
--    remove those — this project has been bitten three times. Expect f, f, t.
SELECT has_function_privilege('anon',          'public.prune_driver_locations(integer)', 'EXECUTE') AS anon_can_run,
       has_function_privilege('authenticated', 'public.prune_driver_locations(integer)', 'EXECUTE') AS authed_can_run,
       has_function_privilege('service_role',  'public.prune_driver_locations(integer)', 'EXECUTE') AS service_can_run;

-- 7. The nightly prune is scheduled.
SELECT jobname, schedule, command, active
  FROM cron.job WHERE jobname = 'prune-driver-locations';

-- 8. Dry run: how many rows would tonight's prune delete? Expect 0 on a fresh
--    table. Run this rather than trusting the interval arithmetic by eye.
SELECT count(*) AS would_delete
  FROM driver_locations
 WHERE recorded_at < now() - interval '30 days';
