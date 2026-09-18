-- Enforcement: refuse a booking outside the company's service areas.
--
-- Design: .claude/notes/service-areas-plan.md §4
--
-- APPLY THIS LAST, and read the paragraph below before you do.
--
-- This is the file that changes behaviour. Everything before it (20260917,
-- 20260918_read_paths) was inert: it let a company DESCRIBE where they work
-- without anything acting on it. From the moment this runs, a passenger booking
-- outside the drawn areas is refused.
--
-- So before applying: look at Settings -> Service Areas for each live company
-- and check the impact readout. A company with one stray test polygon will
-- start refusing nearly everything — at the time of writing Northstar Taxi had
-- exactly one area (a Halifax polygon) and the readout said 130 of its last 140
-- rides would be refused. That is the feature working correctly and the data
-- being wrong, which is the worst combination to discover in production.
--
-- WHY A TRIGGER. Three separate clients INSERT into rides directly —
-- PassengerHomeScreen (card at :1219, cash at :1266) and the dashboard
-- (DashboardPage:3227). A check in any one of them is a check in one of three
-- doors. The trigger is the only thing that sees all three.
--
-- The fourth door, edit-ride's `relocate`, is NOT covered here: it runs
-- service_role, which this trigger exempts by design, so it carries its own
-- check via _shared/serviceArea.ts. Same trap as the vehicle-class surcharge —
-- a server path that forgets the new input reverts the fix with nothing failing
-- loudly.
--
-- INSERT only, deliberately. A non-staff UPDATE of pickup/dropoff coordinates
-- is already refused by guard_ride_route_fields (20260751), so there is no second
-- path in for a passenger; adding UPDATE here would only re-check rows that
-- staff or service_role are allowed to move anyway.

CREATE OR REPLACE FUNCTION guard_ride_service_area()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Edge Functions (service_role) and direct DB access (SQL editor / psql /
  -- cron, where there is no JWT so auth.role() is NULL) are always allowed.
  -- Same arms as guard_ride_fare_fields, for the same reasons: the edge
  -- functions do their own checking, and the NULL arm is what lets a ride still
  -- be fixed by hand.
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Dispatch: allowed, and this is a product decision, not an oversight. An
  -- out-of-area airport run agreed on the phone is legitimate revenue, and a
  -- dispatcher who cannot book what the owner just promised will stop using the
  -- dashboard. The dashboard shows them a confirmable warning instead; the
  -- refusal is for the passenger app, where nobody is on the phone to judge.
  IF get_my_role() IN ('admin', 'dispatcher') THEN
    RETURN NEW;
  END IF;

  IF NOT company_serves_point(
       NEW.company_id, NEW.pickup_lat, NEW.pickup_lng, 'pickup') THEN
    RAISE EXCEPTION 'ride_pickup_out_of_area'
      USING ERRCODE = 'check_violation',
            HINT    = 'This company does not pick up at that address.';
  END IF;

  IF NOT company_serves_point(
       NEW.company_id, NEW.dropoff_lat, NEW.dropoff_lng, 'dropoff') THEN
    RAISE EXCEPTION 'ride_dropoff_out_of_area'
      USING ERRCODE = 'check_violation',
            HINT    = 'This company does not drop off at that address.';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions are not meant to be callable directly, and Supabase default
-- privileges grant EXECUTE to anon and authenticated BY NAME — so revoking from
-- public alone leaves both intact (20260776 did this sweep for the others).
REVOKE EXECUTE ON FUNCTION guard_ride_service_area()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS guard_ride_service_area ON rides;

CREATE TRIGGER guard_ride_service_area
  BEFORE INSERT ON rides
  FOR EACH ROW EXECUTE FUNCTION guard_ride_service_area();
