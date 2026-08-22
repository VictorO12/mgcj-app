-- ═══════════════════════════════════════════════════════════════════════════
-- Does a driver actually hold the passenger's REAL phone number?
-- Live verification, to run in the Supabase SQL editor before designing a fix.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. The claim under test came from reading four overlapping
-- migration files (20260627_rls_leak_fixes, 20260715_dispatcher_role_split,
-- 20260715_inline_staff_check_in_rls, 20260715_break_rls_cycle), each of which
-- DROPs and recreates "profiles select policy". Only the last one applied wins,
-- and per migration-files-are-not-applied-state we do not know from the repo
-- which that was -- or whether any of them ran. 20260627_fix_remaining_leaks.sql
-- was written, committed, and never applied, and a later migration then cited
-- its helper as "the existing helper". Do not repeat that here.
--
-- Everything is read-only. Query 5 opens a transaction and ROLLBACKs.


-- ═══════════════════════════════════════════════════════════════════════
-- 1. EVERY select policy on profiles -- not just the one we expect
-- ═══════════════════════════════════════════════════════════════════════
-- Policies are OR'd, so a second permissive policy nobody remembers widens
-- access on its own. A RESTRICTIVE policy (permissive = 'RESTRICTIVE') is the
-- opposite and would AND-narrow -- if one exists, the whole analysis changes.
SELECT policyname,
       permissive,
       roles,
       qual AS using_expression
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename  = 'profiles'
   AND cmd IN ('SELECT', 'ALL')
 ORDER BY permissive, policyname;

-- EXPECT (from the repo's best guess): exactly one PERMISSIVE policy named
-- "profiles select policy", whose USING has three OR branches -- self, staff,
-- and a ride-sharing check.
-- If you see MORE than one permissive row, the extra one is the finding.


-- ═══════════════════════════════════════════════════════════════════════
-- 2. Is the ride-sharing branch time-bounded? (the load-bearing question)
-- ═══════════════════════════════════════════════════════════════════════
-- The repo version of shares_ride_with() has NO status filter and NO time
-- filter: any ride ever shared admits the row forever. If that is what is live,
-- a driver can read the phone of every passenger they have ever carried, for
-- life -- long after the 2h masked-telephony window has closed.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS security_definer,
       p.provolatile,
       pg_get_functiondef(p.oid)                 AS full_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('shares_ride_with', 'is_staff', 'get_my_role', 'get_my_company_id');

-- Read full_definition for shares_ride_with and answer one question:
--   does its WHERE mention rides.status or any timestamp at all?
-- If not -> unbounded, and that is the real finding, not the column exposure.
-- Absent entirely (0 rows) -> the policy in query 1 cannot be the repo version;
-- re-read what query 1 actually returned.


-- ═══════════════════════════════════════════════════════════════════════
-- 3. Column-level privileges on profiles.phone
-- ═══════════════════════════════════════════════════════════════════════
-- RLS gates rows, not columns -- but Postgres column GRANTs are a SEPARATE
-- layer that RLS does not override, and they are the mechanism a fix would use.
-- This shows whether anything has already been done here (expected: nothing).
SELECT grantee, table_name, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name   = 'profiles'
   AND column_name  = 'phone'
   AND grantee IN ('authenticated', 'anon', 'service_role')
 ORDER BY grantee;

-- Also the table-wide grant, since a table-level SELECT covers every column
-- unless a column grant narrows it:
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name   = 'profiles'
   AND grantee IN ('authenticated', 'anon', 'service_role')
 ORDER BY grantee, privilege_type;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. Who else legitimately reads profiles.phone -- the blast radius
-- ═══════════════════════════════════════════════════════════════════════
-- Any fix that revokes the column breaks these unless they are re-admitted.
-- Known from code, listed here so the fix is designed against all of them:
--   - dispatch dashboard: dispatchers CALL passengers; guest passengers booked
--     by dispatch are KEYED by phone
--   - OTPVerifyScreen guest-merge: matches a pre-existing guest profile by phone
--   - sync-ride-contact: reads both real numbers (service_role -- unaffected)
-- This finds any SECURITY DEFINER function that already reads it, which would
-- be a ready-made escape hatch:
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.prosecdef
   AND pg_get_functiondef(p.oid) ILIKE '%phone%'
 ORDER BY p.proname;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. THE BEHAVIOURAL PROOF -- this one outranks all of the above
-- ═══════════════════════════════════════════════════════════════════════
-- Policy text can be misread; a returned phone number cannot. Impersonate a
-- real driver and try to read a real passenger's phone.
--
-- Substitute:
--   <DRIVER PROFILE UUID>     a driver who has completed a ride
--   <PASSENGER PROFILE UUID>  a passenger on a ride that driver COMPLETED
--                             (deliberately an OLD, finished ride -- the point
--                              is whether access outlives the ride)
BEGIN;
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub',  '<DRIVER PROFILE UUID>',
                                      'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- (a) The exact query the mobile app issues (DriverApp.tsx:582).
  SELECT id, name, phone, avatar_url
    FROM profiles
   WHERE id = '<PASSENGER PROFILE UUID>'::uuid;
  -- A ROW WITH A PHONE NUMBER = confirmed. The driver holds the real number and
  -- deleting `phone` from the client .select() would have changed nothing.
  -- ZERO ROWS = the live policy is narrower than the repo suggests; stop and
  -- re-plan off query 1's actual output.

  -- (b) Does it outlive the ride? Same read, reported alongside how long ago
  -- that ride finished. Access surviving here is the durable exposure -- the
  -- masked line closes at completed_at + 2h, this does not.
  SELECT r.id AS ride_id,
         r.status,
         r.completed_at,
         age(now(), r.completed_at)                        AS finished_how_long_ago,
         (SELECT phone FROM profiles WHERE id = r.passenger_id) AS passenger_phone_readable
    FROM rides r
   WHERE r.driver_id = '<DRIVER PROFILE UUID>'::uuid
     AND r.completed_at IS NOT NULL
   ORDER BY r.completed_at ASC
   LIMIT 5;
  -- passenger_phone_readable non-null on the OLDEST completed ride = unbounded.
ROLLBACK;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. The reverse direction -- passenger reading the DRIVER's number
-- ═══════════════════════════════════════════════════════════════════════
-- useActiveRide.ts:229 fetches it, so this is symmetric, and shares_ride_with()
-- is bidirectional by construction. Worth confirming rather than assuming: a
-- driver's personal number reaching a passenger permanently is the harassment
-- vector that masked telephony exists to close, pointed the other way.
BEGIN;
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub',  '<PASSENGER PROFILE UUID>',
                                      'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT id, name, phone FROM profiles WHERE id = '<DRIVER PROFILE UUID>'::uuid;
ROLLBACK;


-- ═══════════════════════════════════════════════════════════════════════
-- 7. Negative control -- do NOT skip this
-- ═══════════════════════════════════════════════════════════════════════
-- A stranger must read nothing. If this returns a row, the finding is far
-- larger than G3 and the ride-sharing branch is not what is admitting the row.
-- If it returns zero, it also proves the impersonation in 5/6 actually took
-- effect -- without it, a zero-row result above is ambiguous between "policy
-- denied it" and "set_config silently did nothing".
BEGIN;
  SELECT set_config('request.jwt.claims',
                    json_build_object('sub',  '<A PROFILE ON NEITHER SIDE>',
                                      'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) AS should_be_zero
    FROM profiles WHERE id = '<PASSENGER PROFILE UUID>'::uuid;
ROLLBACK;
