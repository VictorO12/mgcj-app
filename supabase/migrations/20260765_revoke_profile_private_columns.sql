-- ═══════════════════════════════════════════════════════════════════════════
-- Withhold the private profile columns from the client roles
--
-- Closes the exposure verified live 2026-08-22: a driver read a passenger's
-- real phone number through the app's own query, on a ride completed two months
-- earlier, via the `shares_ride_with()` branch of "profiles select policy" —
-- which has no status filter and no time bound and is symmetric, so the
-- passenger read the driver's personal number back.
--
-- Requires 20260764 (the definer readers) to be applied FIRST, and the client
-- reroutes to be SHIPPED first — the apps must already be reading these columns
-- through the RPCs before the columns stop being readable.
--
-- ─── Why this is not `REVOKE SELECT (phone)` ───────────────────────────────
-- Because that does nothing. Rehearsed live 2026-08-23 inside a transaction:
-- the number still came back. A column-level REVOKE cannot carve a hole in a
-- table-wide SELECT grant — Postgres emits a warning and access is unchanged.
-- The failure mode is "migration applied, no error, still readable", which is
-- the same shape as cron.job_run_details reporting SUCCESS while the function
-- 401'd. So: drop the table grant, re-grant an explicit column list.
--
-- ─── Why a revoke and not a narrower policy ────────────────────────────────
-- Narrowing shares_ride_with() to live rides would also remove the row, and the
-- row is load-bearing: ride history and DriverProfileSheet need the counterparty
-- name and avatar. Only the columns need to disappear.
-- ═══════════════════════════════════════════════════════════════════════════

-- anon gets nothing back. Every policy on profiles is TO authenticated (the
-- three {public}-role policies are INSERT/UPDATE, so none of them is a read
-- path), which means RLS already denies anon every row and this grant has been
-- dead weight. Guest bookers are `authenticated` — anonymous sign-in is a real
-- auth.users row — and the pre-session flows (phone_is_registered) are definer
-- RPCs, not table reads. Nothing anon-side reads this table.
REVOKE SELECT ON public.profiles FROM anon;

REVOKE SELECT ON public.profiles FROM authenticated;

-- Enumerated from the live table 2026-08-23, minus the five withheld columns:
--   phone, guest_phone, email, student_email, stripe_customer_id
-- push_token is granted for now; see 20260764's my_private_profile() for the
-- open question about Expo tokens being credentials in themselves.
GRANT SELECT (
  id,
  name,
  role,
  company_id,
  avatar_url,
  created_at,
  is_active,
  deactivation_pending,
  deleted_at,
  notification_prefs,
  push_token,
  is_guest,
  student_verified,
  student_institution_id,
  student_verified_at
) ON public.profiles TO authenticated;

COMMENT ON TABLE public.profiles IS
  'SELECT is granted per-column, not table-wide: phone, guest_phone, email, '
  'student_email and stripe_customer_id are withheld from anon/authenticated '
  'and reachable only through profile_phone() / profile_phones() / '
  'my_private_profile() (20260764). A NEW COLUMN IS THEREFORE INVISIBLE TO THE '
  'CLIENTS UNTIL IT IS GRANTED HERE, and it must also be added to '
  'PROFILE_COLUMNS in mgcj-app/src/hooks/AuthContext.tsx and '
  'mgcj-dashboard/src/hooks/useAuth.ts — three edits, or it silently reads '
  'empty rather than failing. See .claude/notes/g3-phone-column-revoke-plan.md';
