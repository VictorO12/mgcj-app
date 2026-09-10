-- Driver trail (dashboard step 4) — verify RLS, and see the view work before
-- the store build exists.
--
-- WHY THIS EXISTS. The dashboard reads driver_locations with NO company filter,
-- relying entirely on the driver_locations_select_staff policy
-- (is_staff() AND company_id = get_my_company_id()). If that policy does not
-- grant what we think, PostgREST returns `data: []` and NO error, which the UI
-- renders as "No location history for this day" — identical to a driver who was
-- simply offline. That is the 200-[] failure mode: silent, and it looks like a
-- working empty state. The only way to tell them apart is to put a row in and
-- see whether the browser can read it.
--
-- It is also the only way to look at this feature at all right now: no device
-- has the background location task until the store build, so every real driver
-- has zero fixes.

-- ─── 1. Is is_staff() actually true for you? ────────────────────────────────
-- Run while signed in as yourself in the SQL editor is NOT the same session as
-- the dashboard, so this only checks the function exists and your role is right.
SELECT p.id, p.name, p.role, p.company_id
  FROM profiles p
 WHERE p.id = auth.uid() OR p.role IN ('admin', 'dispatcher')
 ORDER BY p.role;

-- ─── 2. Seed a day's trail for a demo driver ────────────────────────────────
-- Kentville -> New Minas, a 25-minute stop, then on to Wolfville. Roughly the
-- shape of a real shift, and enough to exercise every part of the view: two
-- coloured segments, a detected stop, the distance total, the scrubber.
--
-- Pick a DEMO driver (is_demo = true) — seeded location history on a real
-- driver's record is exactly the kind of thing that later gets mistaken for
-- evidence.

WITH driver AS (
  SELECT d.id, p.company_id
    FROM drivers d JOIN profiles p ON p.id = d.id
   WHERE d.is_demo
   ORDER BY p.name
   LIMIT 1
),
-- One of that driver's own rides, so the middle leg draws as "on a fare"
-- (orange) and the rest as "between fares" (grey).
fare AS (
  SELECT r.id FROM rides r, driver WHERE r.driver_id = driver.id LIMIT 1
),
leg1 AS (  -- driving, 30 min
  SELECT gs AS i,
         45.0777 + (45.0700 - 45.0777) * (gs / 60.0) AS lat,
         -64.4959 + (-64.4400 - -64.4959) * (gs / 60.0) AS lng,
         date_trunc('day', now()) + interval '9 hours' + (gs * interval '30 seconds') AS t,
         NULL::uuid AS ride_id
    FROM generate_series(0, 60) gs
),
leg2 AS (  -- stopped at New Minas, 25 min (jitter only)
  SELECT gs, 45.0700 + (random() - 0.5) * 0.0002,
             -64.4400 + (random() - 0.5) * 0.0002,
         date_trunc('day', now()) + interval '9 hours 30 minutes' + (gs * interval '1 minute'),
         NULL::uuid
    FROM generate_series(0, 25) gs
),
leg3 AS (  -- on a fare to Wolfville, 20 min
  SELECT gs,
         45.0700 + (45.0918 - 45.0700) * (gs / 40.0),
         -64.4400 + (-64.3646 - -64.4400) * (gs / 40.0),
         date_trunc('day', now()) + interval '9 hours 56 minutes' + (gs * interval '30 seconds'),
         (SELECT id FROM fare)
    FROM generate_series(0, 40) gs
)
INSERT INTO driver_locations (driver_id, company_id, ride_id, recorded_at, lat, lng, accuracy)
SELECT driver.id, driver.company_id, l.ride_id, l.t, l.lat, l.lng, 12
  FROM driver, (
    SELECT * FROM leg1 UNION ALL SELECT * FROM leg2 UNION ALL SELECT * FROM leg3
  ) AS l(i, lat, lng, t, ride_id);

-- ─── 3. Look at it ──────────────────────────────────────────────────────────
-- Dashboard -> Drivers -> that demo driver -> "View this driver's trail".
-- Today's date. Expect: a grey line into New Minas, a numbered stop marker
-- reading ~25m, an orange line on to Wolfville, ~11 km driven, and a scrubber
-- that walks a blue dot along the route.
--
-- If it says "No location history for this day" while this query returns rows,
-- the RLS policy is the problem, not the pipeline:
SELECT count(*), min(recorded_at), max(recorded_at)
  FROM driver_locations
 WHERE recorded_at >= date_trunc('day', now());

-- ─── 4. Remove the seed when done ───────────────────────────────────────────
-- Scoped to demo drivers so it can never take a real trail with it.
-- DELETE FROM driver_locations
--  WHERE driver_id IN (SELECT id FROM drivers WHERE is_demo);
