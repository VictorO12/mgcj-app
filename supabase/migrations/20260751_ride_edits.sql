-- Passenger ride edits: reschedule a scheduled ride, or change where it goes.
--
-- Two halves, and the second is the load-bearing one.
--
-- 1. Bookkeeping columns for the new `edit-ride` Edge Function (edit_count so a
--    passenger can't run up Directions calls by tapping, dropoff_changed_at so
--    the driver's nav and dispatch can both see that the destination moved).
--
-- 2. A freeze on the route columns (and scheduled_at) themselves. This closes a leak that exists
--    TODAY, independently of the edit feature: RLS lets a passenger UPDATE
--    their own ride, and RLS gates rows rather than columns, so a passenger
--    could already rewrite dropoff_lat/lng to somewhere far away while
--    guard_ride_fare_fields held fare_estimate at the old, cheap number. Same
--    class of bug as the $0.75 ride in 20260713 — the fare was frozen but the
--    thing the fare is computed FROM was not.
--
-- Staff (dispatch edits rides from the dashboard) and service-role (the
-- edit-ride function, which re-prices before it writes) are exempt, exactly as
-- in guard_ride_fare_fields. Direct DB access (SQL editor / psql, where
-- auth.role() is NULL) stays allowed so manual fixes still work.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS edit_count         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dropoff_changed_at timestamptz;

COMMENT ON COLUMN rides.edit_count IS
  'Number of passenger edits applied via edit-ride. Bounds the per-ride Directions spend; frozen against client writes.';
COMMENT ON COLUMN rides.dropoff_changed_at IS
  'Set by edit-ride when the destination moves. The driver nav screen re-routes off this; dispatch surfaces it on the ride detail.';

-- ─── Freeze the route + edit bookkeeping against passenger/driver writes ────
CREATE OR REPLACE FUNCTION guard_ride_route_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF is_staff() THEN
    RETURN NEW;
  END IF;

  IF NEW.pickup_lat      IS DISTINCT FROM OLD.pickup_lat
     OR NEW.pickup_lng      IS DISTINCT FROM OLD.pickup_lng
     OR NEW.pickup_address  IS DISTINCT FROM OLD.pickup_address
     OR NEW.dropoff_lat     IS DISTINCT FROM OLD.dropoff_lat
     OR NEW.dropoff_lng     IS DISTINCT FROM OLD.dropoff_lng
     OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN
    RAISE EXCEPTION 'Pickup and dropoff are read-only — use the edit-ride function';
  END IF;

  -- scheduled_at belongs in the same freeze. Routing the app's time edit
  -- through edit-ride fixed the CALLER, not the capability: RLS still let a
  -- passenger write scheduled_at directly, which would skip dropping a
  -- driver's soft claim, skip telling them, and skip the notified_*/leave_by
  -- resets. Freezing it is what makes "a claimant is always told when the ride
  -- they claimed moves" a guarantee rather than a convention the client
  -- happens to follow.
  IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    RAISE EXCEPTION 'Scheduled time is read-only — use the edit-ride function';
  END IF;

  IF NEW.edit_count         IS DISTINCT FROM OLD.edit_count
     OR NEW.dropoff_changed_at IS DISTINCT FROM OLD.dropoff_changed_at THEN
    RAISE EXCEPTION 'Edit bookkeeping is read-only';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ride_route_fields ON rides;
CREATE TRIGGER trg_guard_ride_route_fields
  BEFORE UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION guard_ride_route_fields();

-- ─── Audit event for a destination/pickup change ───────────────────────────
-- Deliberately NOT a re-enumerated list. The last repo migration to rewrite
-- this constraint was 20260716, but the live constraint has drifted since —
-- re-stating the list from the repo dropped whatever was added by hand in the
-- SQL editor, and existing rows then failed the check. Same lesson as
-- 20260745: the repo records intent, the database records state.
--
-- So: read the live definition and splice one value into it. Whatever is
-- actually allowed today stays allowed, and this is idempotent on re-run.
DO $$
DECLARE
  def     text;
  new_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'dispatch_events'::regclass
    AND conname  = 'dispatch_events_event_type_check';

  IF def IS NULL THEN
    RAISE EXCEPTION 'dispatch_events_event_type_check not found — check it live before assuming';
  END IF;

  IF position('''ride.route_modified''' IN def) > 0 THEN
    RAISE NOTICE 'ride.route_modified already allowed — nothing to do';
    RETURN;
  END IF;

  new_def := replace(def, 'ARRAY[', 'ARRAY[''ride.route_modified''::text, ');
  IF new_def = def THEN
    RAISE EXCEPTION 'Could not splice into the check constraint. Live definition was: %', def;
  END IF;

  EXECUTE 'ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_type_check';
  EXECUTE 'ALTER TABLE dispatch_events ADD CONSTRAINT dispatch_events_event_type_check ' || new_def;
END $$;
