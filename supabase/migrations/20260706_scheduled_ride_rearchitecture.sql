-- Scheduled-ride re-architecture — §2
-- Adds preassignment, coverage-tracking, and dispatch-audit columns to rides.
--
-- Retired columns (auto_started, confirmed_by_driver, escalated,
-- notified_30min, notified_15min) are intentionally NOT dropped here.
-- De-reference in code first, then drop in a follow-up migration.
--
-- Apply via Supabase dashboard SQL editor AND keep this file for the
-- post-Oct-30-2026 GRANT convention (columns on existing tables don't
-- need new table grants, but this file documents the change).

-- ── Preassignment (dispatch preference — NOT a binding claim) ────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS preferred_driver_id      uuid          NULL
    REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preferred_driver_exclusive boolean      NOT NULL DEFAULT false;

-- ── Coverage tracking ────────────────────────────────────────────────────────
-- Three states: uncovered (no eligible driver exists at all) /
--               at_risk   (drivers exist but none active, or exclusive driver offline) /
--               covered   (at least one active eligible driver)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS coverage_status          text          NOT NULL DEFAULT 'covered'
    CHECK (coverage_status IN ('uncovered','at_risk','covered'));

-- ── Go-ack timer source of truth ─────────────────────────────────────────────
-- rides.updated_at resets on EVERY UPDATE (confirmed via live trigger check).
-- offered_at is only written when status transitions to 'offered', so
-- reassign-stale-rides can key its 60-second window off this column safely.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS offered_at               timestamptz   NULL;

-- ── Assignment audit trail ───────────────────────────────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS assignment_source        text          NULL
    CHECK (assignment_source IN ('preferred','auto_offer','dispatch_manual'));

-- ── Preferred-driver advance heads-up idempotency guard ─────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS preferred_notified       boolean       NOT NULL DEFAULT false;

-- ── Cron jobs to register in Supabase dashboard after deploying the new functions
-- (do not run these here — the service-role JWT is project-specific and must be
-- copied from the existing cron jobs in pg_cron):
--
-- scheduled-release (every 2 minutes):
--   SELECT cron.schedule(
--     'scheduled-release',
--     '*/2 * * * *',
--     $$SELECT net.http_post(
--       url := 'https://hhsqwmftrrmtodvvuyxq.supabase.co/functions/v1/scheduled-release',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_jwt>"}'::jsonb,
--       body := '{}'::jsonb
--     )$$
--   );
--
-- scheduled-coverage-monitor (every 10 minutes):
--   SELECT cron.schedule(
--     'scheduled-coverage-monitor',
--     '*/10 * * * *',
--     $$SELECT net.http_post(
--       url := 'https://hhsqwmftrrmtodvvuyxq.supabase.co/functions/v1/scheduled-coverage-monitor',
--       headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_jwt>"}'::jsonb,
--       body := '{}'::jsonb
--     )$$
--   );
--
-- Cutover — unschedule the legacy cron once new functions are verified:
--   SELECT cron.unschedule('scheduled-lifecycle');  -- jobid 10
--   (process-scheduled-rides, scheduled-ride-reminders, schedule-rides
--    are already unscheduled per Step 0 live checks — no action needed)
