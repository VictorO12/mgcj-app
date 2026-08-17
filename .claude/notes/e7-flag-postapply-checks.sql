-- ═══════════════════════════════════════════════════════════════════════════
-- E7 passenger flag — post-apply verification
-- Run in the Supabase SQL editor after 20260752_passenger_ride_flag.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Grants + leftover overloads, in one query ───────────────────────────
-- Want EXACTLY two rows:
--     flag_ride(uuid, text[], text)        authenticated=t  anon=f  definer=t
--     get_ride_dispatch_phone(uuid)        authenticated=t  anon=f  definer=t
--
-- A THIRD row for flag_ride(uuid, text, text) means the superseded first cut
-- is still installed — run section 3 below.
--
-- authenticated=f is the failure that matters: a silent "permission denied"
-- on the exact screen a trapped passenger is looking at. Anonymous guest
-- sessions carry the `authenticated` role, not `anon`, so anon=f is correct
-- and does NOT lock guests out.
SELECT p.oid::regprocedure                                   AS function_signature,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
       p.prosecdef                                           AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('flag_ride', 'get_ride_dispatch_phone')
ORDER BY 1;

-- ── 2. Columns ─────────────────────────────────────────────────────────────
-- Want: passenger_flag_note, passenger_flag_reasons (ARRAY),
--       passenger_flag_resolved_at, passenger_flag_updated_at,
--       passenger_flagged_at.
-- `passenger_flag_reason` (SINGULAR) appearing means the first cut is still
-- there — run section 3.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'rides' AND column_name LIKE 'passenger_flag%'
ORDER BY column_name;

-- ── 3. Cleanup, only if 1 or 2 showed the first cut ────────────────────────
-- No-ops otherwise. The DROP COLUMN is the one destructive statement here; it
-- can only hold flags written by the superseded version.
DROP FUNCTION IF EXISTS flag_ride(uuid, text, text);
ALTER TABLE rides DROP COLUMN IF EXISTS passenger_flag_reason;

-- ── 4. Does the grant actually work? ───────────────────────────────────────
-- Privileges above are necessary but not sufficient — this proves the call is
-- reachable as a passenger. auth.uid() is NULL here, so the CORRECT result is
-- the function's own rejection:
--
--   ERROR: Ride not found            → GRANT WORKS. This is what you want.
--   ERROR: permission denied for function flag_ride
--                                    → grant is broken, fix before shipping.
BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT flag_ride('00000000-0000-0000-0000-000000000000'::uuid, ARRAY['not_in_car']);
ROLLBACK;

-- ── 5. Dispatch phones are set ─────────────────────────────────────────────
SELECT name, phone FROM companies ORDER BY name;
