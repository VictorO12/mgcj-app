-- The company's city: the map's answer when nothing has been drawn yet.
--
-- Design: .claude/notes/service-areas-plan.md §2
--
-- Replaces two things with one. `service_center_lat/lng` (added hours earlier in
-- 20260917) was a "drop a pin on your dispatch office" idea that never got a UI
-- and is NULL on every row — and separately, every map in the platform fell
-- back to a hardcoded Kentville when it had nothing else. A company in Moncton
-- opened on a map 1,000 km away.
--
-- A city asked once at onboarding beats both: it is one question, it is a thing
-- the owner knows without looking anything up, and unlike a billing address it
-- describes where the cars are rather than where the mail goes.
--
-- THE VIEWPORT IS THE POINT. Google returns bounds for a city, not just a
-- centre — so Moncton frames as Moncton, the whole city at the right zoom,
-- instead of a point plus a guessed span. Same "position and extent from one
-- source" property that makes drawn areas the best answer; a lone coordinate
-- can't express extent, which is what left a magic zoom constant in the code
-- the first time round.
--
-- Geocoded ONCE, here, not on every page load: the answer never changes and a
-- read-time geocode would be a billed Places call per dispatcher per refresh.

ALTER TABLE companies
  DROP COLUMN IF EXISTS service_center_lat,
  DROP COLUMN IF EXISTS service_center_lng;

ALTER TABLE companies
  -- Human label, exactly as picked: 'Moncton, NB, Canada'. Shown in Settings so
  -- an owner can see what the map is using and correct it.
  ADD COLUMN IF NOT EXISTS service_city       text,

  -- The city centre, from the same Places result.
  ADD COLUMN IF NOT EXISTS service_city_lat   double precision,
  ADD COLUMN IF NOT EXISTS service_city_lng   double precision,

  -- Places viewport. All four or none — a partial box cannot be fitted, and the
  -- CHECK below is what stops a half-written row from silently degrading to the
  -- centre point with nobody noticing.
  ADD COLUMN IF NOT EXISTS service_city_north double precision,
  ADD COLUMN IF NOT EXISTS service_city_south double precision,
  ADD COLUMN IF NOT EXISTS service_city_east  double precision,
  ADD COLUMN IF NOT EXISTS service_city_west  double precision;

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_service_city_viewport_complete;

ALTER TABLE companies
  ADD CONSTRAINT companies_service_city_viewport_complete CHECK (
    (service_city_north IS NULL AND service_city_south IS NULL
     AND service_city_east IS NULL AND service_city_west IS NULL)
    OR
    (service_city_north IS NOT NULL AND service_city_south IS NOT NULL
     AND service_city_east IS NOT NULL AND service_city_west IS NOT NULL)
  );

COMMENT ON COLUMN companies.service_city IS
  'City this company operates out of, picked from Google Places at onboarding. '
  'Used to frame every map for this company when no service areas are drawn. '
  'Replaced a hardcoded Kentville fallback.';

-- Backfill the existing rows. Without this they would have no fallback at all
-- once the Kentville constant is deleted from the three client surfaces, and a
-- brand-new company is the ONLY case that is supposed to have no answer.
--
-- Coordinates and viewports are Google's for each city, entered by hand here
-- because these four rows predate the picker.
UPDATE companies SET
  service_city       = 'Kentville, NS, Canada',
  service_city_lat   = 45.0775,  service_city_lng  = -64.4958,
  service_city_north = 45.1110,  service_city_south = 45.0430,
  service_city_east  = -64.4480, service_city_west  = -64.5440
WHERE service_city IS NULL
  AND name IN ('M&G Cab Ltd', 'M&G Cab Ltd (original)', 'Test Company');

UPDATE companies SET
  service_city       = 'Halifax, NS, Canada',
  service_city_lat   = 44.6488,  service_city_lng  = -63.5752,
  service_city_north = 44.7300,  service_city_south = 44.5800,
  service_city_east  = -63.4900, service_city_west  = -63.6800
WHERE service_city IS NULL
  AND name = 'Northstar Taxi';
