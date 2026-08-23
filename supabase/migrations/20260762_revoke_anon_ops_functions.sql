-- The ops_* reporting functions are readable by anon. Close them.
--
-- Verified live 2026-08-23, not inferred: a POST to /rest/v1/rpc/ops_revenue
-- carrying only SUPABASE_ANON_KEY -- the publishable key that ships inside the
-- mgcj-app bundle, extractable from any APK -- returned HTTP 200 with
-- per-company revenue for every company on the platform (company_name,
-- fee_percent, fares_total, fee_total, refund_total, by month and payment
-- method). ops_health_system() likewise returned cron job names, schedules,
-- last-run status and 24h failure counts.
--
-- Cause: 20260714 / 20260730 / 20260732 each did
--
--     revoke all on function ... from public;
--     grant execute on function ... to service_role;
--
-- and their comments claim "execute granted only to service_role". That is not
-- what happened. Supabase's default privileges grant EXECUTE **directly to the
-- anon and authenticated roles**, which is a separate grant from PUBLIC, so
-- revoking PUBLIC leaves both in place. proacl still read
-- `anon=X/postgres,authenticated=X/postgres` on all three.
--
-- This is the same finding as 20260734 (reap_stale_drivers), which is the only
-- migration in the repo that revokes correctly:
--
--     revoke execute on function ... from public, anon, authenticated;
--
-- 20260714 predates it and was never retro-fixed. 20260757 dropped
-- merge_guest_profile, a third instance. Rule: revoking from PUBLIC is not
-- enough -- revoke from anon and authenticated BY NAME, then grant to the one
-- role that should have it.
--
-- vellon-ops reaches these through its service-role connector
-- (lib/connectors/mgcj.ts), so it is unaffected by the revoke.

REVOKE EXECUTE ON FUNCTION public.ops_revenue(timestamptz, timestamptz)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ops_revenue(timestamptz, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.ops_settlement_reconciliation(timestamptz, timestamptz)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ops_settlement_reconciliation(timestamptz, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.ops_health_system()
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ops_health_system()
  TO service_role;
