-- Per-driver digest state + a real "this ride became claimable" timestamp.
--
-- The digest notifies a driver about a scheduled ride at most ONCE, ever. That
-- needs two things: a per-driver high-water mark of what they've already been
-- told about, and a per-ride timestamp of when the ride entered the claimable
-- pool. Comparing against rides.created_at was the obvious shortcut and is
-- wrong: work that becomes claimable AGAIN — a soft claim released, a dispatch
-- preference cleared, a driver handing a ride back — keeps its original
-- created_at, which is already below every driver's watermark, so the ride
-- silently re-enters the pool with nobody notified.
--
-- No GRANTs: both tables predate the post-2026-10-30 requirement and new
-- columns inherit existing privileges.

-- ── 1. Per-ride: when did this become claimable ─────────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS became_open_at timestamptz NULL;

COMMENT ON COLUMN rides.became_open_at IS
  'When this ride last entered the claimable pool (scheduled, no driver, no preferred driver). Re-stamped each time it re-opens — unlike created_at, which is why the digest keys off this.';

-- Backfill BEFORE the trigger exists. Ordering matters: a BEFORE UPDATE trigger
-- installed first would fire on every backfill row, and while this particular
-- trigger would leave an explicit value alone (an already-open row updated to
-- still-open is not a transition), relying on that is exactly the trap the
-- 20260719 fee-snapshot migration hit. Install order removes the question.
UPDATE rides
   SET became_open_at = created_at
 WHERE became_open_at IS NULL
   AND status = 'scheduled'
   AND driver_id IS NULL
   AND preferred_driver_id IS NULL;

-- Stamped on INSERT as well as UPDATE, so a newly booked scheduled ride has a
-- became_open_at from the start and the digest never has to fall back to
-- created_at. One column answers the question in every case.
CREATE OR REPLACE FUNCTION set_ride_became_open_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  now_open boolean;
  was_open boolean;
BEGIN
  now_open := (NEW.status = 'scheduled'
               AND NEW.driver_id IS NULL
               AND NEW.preferred_driver_id IS NULL);

  IF TG_OP = 'INSERT' THEN
    IF now_open AND NEW.became_open_at IS NULL THEN
      NEW.became_open_at := now();
    END IF;
    RETURN NEW;
  END IF;

  was_open := (OLD.status = 'scheduled'
               AND OLD.driver_id IS NULL
               AND OLD.preferred_driver_id IS NULL);

  -- Only a genuine transition INTO the open state re-stamps. Deliberately not
  -- cleared when the ride leaves the pool: the column is only ever read while
  -- the ride is open, and keeping the last value makes "when did this last
  -- become available" answerable after the fact.
  IF now_open AND NOT was_open THEN
    NEW.became_open_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ride_became_open_at ON rides;
CREATE TRIGGER trg_ride_became_open_at
  BEFORE INSERT OR UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION set_ride_became_open_at();

-- ── 2. Per-driver digest state ──────────────────────────────────────────────
-- On drivers rather than a new preferences table: push_token, last_seen_at and
-- is_active already live here, so this is where a reader looks for "how do we
-- reach this driver". A preferences table earns its keep when there are real
-- per-driver settings to hold; there are none yet (NotificationsScreen is still
-- local-only UI), and building the table before the settings is how a v1 slips.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS digest_watermark_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS digest_last_sent_at timestamptz NULL;

COMMENT ON COLUMN drivers.digest_watermark_at IS
  'Highest rides.became_open_at this driver has been notified about. NULL = never evaluated; the digest seeds it silently rather than sending the whole backlog as one push.';
COMMENT ON COLUMN drivers.digest_last_sent_at IS
  'Last digest push accepted by Expo for this driver. Rate-limit floor only — see the two-tier ceiling in scheduled-ride-digest.';

-- The digest sweeps open rides by became_open_at every 15 min.
CREATE INDEX IF NOT EXISTS idx_rides_open_became
  ON rides (became_open_at)
  WHERE status = 'scheduled' AND driver_id IS NULL AND preferred_driver_id IS NULL;

-- ── Verify live after applying (a file in the repo is not proof it ran) ─────
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'drivers' AND column_name LIKE 'digest%';
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'rides'::regclass AND NOT tgisinternal;
--   SELECT count(*) FROM rides WHERE became_open_at IS NOT NULL;
