-- Checks for 20260772_rls_initplan_hoisting.sql
--
-- Wrapping a policy predicate in (select ...) is supposed to change only WHEN
-- it is evaluated, never WHAT it returns. This file proves that on live data
-- rather than assuming it, because the failure modes are a lockout (dispatch
-- sees nothing) and a leak (one company sees another's rides) -- and the second
-- one is silent.
--
-- RUN SECTION 1 BEFORE APPLYING. Its numbers are the baseline; there is no way
-- to reconstruct them afterwards.
--
-- HOW TO RUN, in the Supabase SQL editor:
--   * one BEGIN..ROLLBACK block per execution -- the editor returns only the
--     LAST result set, so running all three together silently discards two.
--   * each block whole -- `SET LOCAL` lives only inside its transaction, so a
--     split block reverts to `postgres`, bypasses RLS, and every count comes
--     back large and meaningless.
--   * no psql meta-commands (\set and friends); the editor is not psql.

-- ── 1. BEFORE: visible-row counts per role ──────────────────────────────────
-- Substitute a real admin and driver uuid.
-- Record every number this prints.

BEGIN;
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"ab2a4a88-0c7a-483c-9e70-00dce21cda33","role":"authenticated"}';
SELECT 'admin' AS who,
       (SELECT count(*) FROM rides)          AS rides,
       (SELECT count(*) FROM drivers)        AS drivers,
       (SELECT count(*) FROM profiles)       AS profiles,
       (SELECT count(*) FROM driver_reports) AS reports;
ROLLBACK;

BEGIN;
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"60cb21c2-e2b6-4925-a786-7ad676827b0b","role":"authenticated"}';
SELECT 'driver' AS who,
       (SELECT count(*) FROM rides)          AS rides,
       (SELECT count(*) FROM drivers)        AS drivers,
       (SELECT count(*) FROM profiles)       AS profiles,
       (SELECT count(*) FROM driver_reports) AS reports;
ROLLBACK;

-- Anonymous: must stay at or near zero. This is the leak check that matters
-- most -- the app ships the anon key, so whatever this returns is public.
BEGIN;
SET LOCAL role anon;
SELECT 'anon' AS who,
       (SELECT count(*) FROM rides)          AS rides,
       (SELECT count(*) FROM drivers)        AS drivers,
       (SELECT count(*) FROM profiles)       AS profiles,
       (SELECT count(*) FROM driver_reports) AS reports;
ROLLBACK;


-- ── BASELINE CAPTURED 2026-09-11, before 20260772 ───────────────────────────
--
--   who     | rides | drivers | profiles          | reports
--   --------+-------+---------+-------------------+--------
--   admin   |  134  |    7    |        26         |    0
--   driver  |  308  |    7    |         5         |    0
--   anon    |    0  |    0    | permission denied |    0
--
-- `permission denied` on profiles-as-anon is the STRONGER result and must stay
-- exactly that: it means the privilege layer is holding, not RLS. If it ever
-- becomes `0`, a GRANT was handed back and only RLS is between the app's anon
-- key and every profile row.

-- ── 2. AFTER: identical block ───────────────────────────────────────────────
-- Re-run section 1 verbatim. EVERY number must match. A count that GREW is a
-- leak; a count that SHRANK is a lockout. Neither is acceptable and both mean
-- revert, not investigate-in-production.


-- ── 3. AFTER: the hoisting actually happened ────────────────────────────────
-- Expect InitPlan lines near the top and NO bare get_my_role()/
-- get_my_company_id() left in the per-row Filter for the admin branch.
-- Baseline to beat: 11.084 ms.

BEGIN;
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"ab2a4a88-0c7a-483c-9e70-00dce21cda33","role":"authenticated"}';
EXPLAIN ANALYZE
  SELECT * FROM rides
  WHERE company_id = '309ea691-202e-4e06-bb37-d8452d42dd41'
  ORDER BY created_at DESC LIMIT 150;
ROLLBACK;


-- ── 4. AFTER: no policy lost its predicate ──────────────────────────────────
-- ALTER POLICY with a typo'd name ERRORS, so a missing policy cannot happen
-- silently -- but a policy whose qual came out NULL would be wide open.
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('rides','drivers','profiles','driver_reports')
  AND cmd <> 'INSERT'
  AND qual IS NULL;
-- Expect: zero rows.


-- ── 5. AFTER: volatility is correct ─────────────────────────────────────────
-- The wrapper only hoists if the function is non-VOLATILE. Both of these had
-- to be fixed by hand; a future helper added as VOLATILE silently un-does this
-- work for whatever policy uses it.
SELECT p.proname,
       CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE'
                          WHEN 's' THEN 'STABLE'
                          WHEN 'v' THEN 'VOLATILE' END AS volatility
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_my_role','get_my_company_id','is_a_driver',
                    'shares_ride_with','driver_in_my_company',
                    'admin_driver_in_my_company');
-- Expect: no VOLATILE rows.
