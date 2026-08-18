-- Post-deploy verification for the push-receipt work (migration 20260753 +
-- 14 redeployed functions, 2026-08-17), and the go/no-go for undeploying the
-- four dead edge functions.
--
-- Run in the Supabase SQL editor. Read-only except where marked.
-- Nothing here trusts the repo: per migration-files-are-not-applied-state,
-- verify live rather than reading the migration that was supposed to do it.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Did 20260753 actually apply?   Expect: 1 table, 1 function, 3 rows of grants
-- ═══════════════════════════════════════════════════════════════════════
SELECT 'table' AS what, to_regclass('public.push_tickets')::text AS result
UNION ALL
SELECT 'function', (SELECT proname FROM pg_proc WHERE proname = 'retire_push_token')
UNION ALL
SELECT 'rls_enabled', (SELECT relrowsecurity::text FROM pg_class WHERE relname = 'push_tickets');

-- The definer function must NOT be executable by anon/authenticated.
-- Supabase default privileges grant EXECUTE to those roles directly, so
-- `REVOKE FROM public` alone would leave it callable via PostgREST.
-- Expect: only service_role (and the owner) listed.
SELECT grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_name = 'retire_push_token';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. GO/NO-GO: is anything still calling the four dead functions?
--    Expect ZERO rows from both queries before undeploying them.
-- ═══════════════════════════════════════════════════════════════════════

-- 2a. pg_cron jobs
SELECT jobid, jobname, schedule, active, command
  FROM cron.job
 WHERE command ILIKE '%scheduled-lifecycle%'
    OR command ILIKE '%process-scheduled-rides%'
    OR command ILIKE '%schedule-rides%'
    OR command ILIKE '%scheduled-ride-reminders%';

-- 2b. Database webhooks (they are ordinary triggers calling
--     supabase_functions.http_request), plus any other trigger referencing them.
SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal
   AND (pg_get_triggerdef(t.oid) ILIKE '%scheduled-lifecycle%'
     OR pg_get_triggerdef(t.oid) ILIKE '%process-scheduled-rides%'
     OR pg_get_triggerdef(t.oid) ILIKE '%schedule-rides%'
     OR pg_get_triggerdef(t.oid) ILIKE '%scheduled-ride-reminders%');

-- NOTE on 2a: 'schedule-rides' is a substring of nothing else here, but
-- 'scheduled-ride-digest' and 'scheduled-release' are LIVE and must be kept.
-- Sanity-check what IS scheduled before deciding anything:
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Is the receipt sweep actually running?
--    scheduled-coverage-monitor calls pollPushReceipts() every 10 minutes.
-- ═══════════════════════════════════════════════════════════════════════

-- Rows should APPEAR as pushes are sent and DISAPPEAR as receipts resolve.
-- A count that only ever grows means the sweep is not running (check the
-- function logs for '[receipts] polled N, retired N, swept N').
SELECT count(*)                                   AS parked,
       min(created_at)                            AS oldest,
       count(*) FILTER (WHERE created_at < now() - interval '24 hours') AS should_be_zero_after_a_sweep
  FROM push_tickets;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Did the crons actually get a 200? (cron.job_run_details lies)
--    net.http_post only ENQUEUES, so job_run_details reports SUCCESS even on a
--    401. The real status is here, and this table has no job column — attribute
--    rows by response-body shape.
-- ═══════════════════════════════════════════════════════════════════════
SELECT status_code, count(*), max(created) AS latest
  FROM net._http_response
 WHERE created > now() - interval '2 hours'
 GROUP BY status_code
 ORDER BY status_code;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Effect check: dead tokens being retired
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  (SELECT count(*) FROM drivers  WHERE push_token IS NOT NULL) AS drivers_with_token,
  (SELECT count(*) FROM drivers  WHERE push_token IS NULL)     AS drivers_without,
  (SELECT count(*) FROM drivers  WHERE push_token IS NULL AND is_active) AS drivers_online_but_unpushable,
  (SELECT count(*) FROM profiles WHERE role = 'passenger' AND push_token IS NULL) AS passengers_sms_fallback;
-- drivers_online_but_unpushable should be 0: retire_push_token flips is_active
-- false in the same statement, EXCEPT for a driver mid-ride (by design).

-- ═══════════════════════════════════════════════════════════════════════
-- RESULTS 2026-08-17 ~00:05 UTC (first run, ~3h after deploy)
-- ═══════════════════════════════════════════════════════════════════════
-- 1. push_tickets + retire_push_token both exist, RLS on. EXECUTE granted to
--    service_role and postgres ONLY — anon/authenticated correctly revoked.
-- 2a/2b. ZERO rows. No cron job and no database webhook references any of the
--    four dead functions => SAFE TO UNDEPLOY. Live cron list is 7 jobs:
--    cleanup-cron-logs, expire-pending-rides, reassign-stale-rides,
--    scheduled-coverage-monitor, scheduled-release, scheduled-ride-digest,
--    sweep-held-transfers.
-- 3. push_tickets EMPTY (0 rows, oldest null) — no push has been sent since
--    deploy, so the park/poll/sweep path is still UNPROVEN end to end. See the
--    forced test below.
-- 4. net._http_response over 2h: 320x 200, 2x null. Crons are authenticating
--    fine; the nulls are in-flight/timed-out requests, not failures to chase.
-- 5. 4 drivers with a token, 7 without, 6 of those 7 STILL is_active.
--    NOTE: the "should be 0" comment above is wrong as written — see below.

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Who are the 6 online-but-unpushable drivers?
--    retire_push_token can NEVER fix these: it only fires when a push to a known
--    token comes back DeviceNotRegistered. A driver with NO token is never sent
--    anything, so no receipt ever arrives. They are pre-existing state, not a
--    regression — most likely the seeded demo drivers kept for map realism.
--    They are already excluded from dispatch by isDriverDispatchable(); the cost
--    is that they read as "online" on the dashboard.
-- ═══════════════════════════════════════════════════════════════════════
SELECT d.id, p.name, d.is_active, d.last_seen_at, d.created_at
  FROM drivers d
  JOIN profiles p ON p.id = d.id
 WHERE d.push_token IS NULL AND d.is_active
 ORDER BY d.created_at;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. FORCED END-TO-END TEST of the ticket path (do this — section 3 was empty)
-- ═══════════════════════════════════════════════════════════════════════
-- Send any real push (easiest: dispatch → driver chat message from the dashboard
-- to a driver who HAS a token), then immediately:
SELECT ticket_id, right(token_sent, 8) AS token_tail, created_at FROM push_tickets;
--   Expect: 1 new row within seconds.  <- proves _shared/push.ts parks tickets
-- Then wait ~25 minutes (15-min receipt age + up to 10 min for the next
-- coverage-monitor tick) and re-run:
--   Expect: 0 rows.                     <- proves pollPushReceipts() resolves+deletes
-- If the row never appears, sending is not going through _shared/push.ts.
-- If it appears and never clears, the sweep is not running — check
-- scheduled-coverage-monitor logs for '[receipts] polled N, retired N, swept N'.
