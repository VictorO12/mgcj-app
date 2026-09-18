-- Service areas: where a company will actually pick you up, and drop you off.
--
-- Design: .claude/notes/service-areas-plan.md
--
-- Three problems, one table:
--   1. Every map in the platform is framed on a hardcoded Annapolis Valley
--      centre (PassengerHomeScreen, DriverHomeScreen, and — worst — the
--      dispatch map, which has no GPS to correct it). A company's drawn areas
--      are the correct framing data: fit the bbox and the constant disappears.
--   2. Nothing stops a passenger booking a pickup in Montreal, or a dropoff
--      1,100 km away. The fare formula is linear and uncapped, so that second
--      one is a ~$1,985 Stripe authorization on a mis-tapped autocomplete row.
--   3. Operators need to say "we serve these towns, we'll also drive to the
--      airport, and nowhere else."
--
-- allows_pickup / allows_dropoff are the whole model. A "named far destination"
-- is not a separate concept — it is an area with allows_pickup = false. The
-- home territory has both flags; the airport likely has dropoff and maybe
-- pickup; anywhere undrawn is refused by omission.
--
-- NOT in this migration, deliberately: per-area PRICING (plan §10). It wants
-- the fare formula consolidated behind a quote-fare function first — the
-- formula currently lives in four places, and adding area rates to it before
-- that recreates the vehicle-class surcharge bug on a bigger surface.

-- ─── 0. PostGIS ─────────────────────────────────────────────────────────────
--
-- Available 3.3.7, not installed (verified 2026-09-17). Into `extensions`, not
-- `public`: installing here would drop several hundred spatial functions into
-- the PostgREST-exposed namespace. Brings spatial_ref_sys (~7 MB) with it.

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE service_areas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- What the dispatcher calls it: 'Kentville + New Minas', 'Halifax Stanfield'.
  name            text NOT NULL,

  -- MultiPolygon, not Polygon, and several rows per company on top of that.
  -- Two different kinds of "multiple" and both are wanted: separately togglable
  -- named areas, AND one named area that is geographically disjoint (a town
  -- plus an outlying village served from the same stand).
  --
  -- geography, not geometry: metres are the unit anyone reasons in, and it
  -- survives the platform leaving Canada — which is the point of the exercise.
  area            extensions.geography(MultiPolygon, 4326) NOT NULL,

  allows_pickup   boolean NOT NULL DEFAULT true,
  allows_dropoff  boolean NOT NULL DEFAULT true,

  active          boolean NOT NULL DEFAULT true,

  -- ── Editor round-trip ONLY. Never read by containment. ──
  -- Tracing an airport freehand is the step where an owner gives up, so the
  -- primary flow for a destination is: search a place, drop a pin, drag a
  -- radius. These three columns exist so that circle re-opens as a circle
  -- instead of as 64 draggable vertices. `area` is generated FROM them (§2
  -- trigger) and is the only thing any containment check reads — two sources
  -- of truth for "is this point inside" is how the client/server fare split
  -- happened, twice.
  shape_kind      text NOT NULL DEFAULT 'polygon'
                  CHECK (shape_kind IN ('polygon', 'circle')),
  center_lat      double precision,
  center_lng      double precision,
  radius_m        numeric,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_areas_circle_has_geometry
    CHECK (
      shape_kind <> 'circle'
      OR (center_lat IS NOT NULL AND center_lng IS NOT NULL
          AND radius_m IS NOT NULL AND radius_m > 0)
    ),

  -- An area that permits neither end is not a restriction, it is a row nobody
  -- can explain later. Deactivate it instead.
  CONSTRAINT service_areas_permits_something
    CHECK (allows_pickup OR allows_dropoff)
);

CREATE INDEX service_areas_area_gix
  ON service_areas USING GIST (area);

-- Every containment check and every framing query starts "this company's
-- active areas".
CREATE INDEX service_areas_company_idx
  ON service_areas (company_id) WHERE active;

COMMENT ON TABLE service_areas IS
  'Where a company picks up and drops off. Zero active rows = serves '
  'everywhere (rollout-safe default, same reasoning as last_seen_at IS NULL '
  '= live). See .claude/notes/service-areas-plan.md';

COMMENT ON COLUMN service_areas.area IS
  'The ONLY geometry containment reads. For shape_kind=circle it is generated '
  'from center_lat/lng + radius_m by service_areas_sync_geometry().';

-- ─── 2. Circle -> geometry, in the database ─────────────────────────────────
--
-- In the DB rather than the dashboard so a circle cannot drift from its own
-- polygon: any client that writes centre/radius gets the matching area, and no
-- client can write an `area` that disagrees with the circle it claims to be.
--
-- ST_Buffer on geography takes metres directly. ST_Multi because the column is
-- MultiPolygon and a buffer comes back as a Polygon.

CREATE OR REPLACE FUNCTION service_areas_sync_geometry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.shape_kind = 'circle' THEN
    NEW.area := extensions.ST_Multi(
      extensions.ST_Buffer(
        extensions.ST_SetSRID(
          extensions.ST_MakePoint(NEW.center_lng, NEW.center_lat), 4326
        )::extensions.geography,
        NEW.radius_m
      )::extensions.geometry
    )::extensions.geography;
  ELSE
    -- A polygon carries no centre/radius; clearing them stops a shape that was
    -- once a circle from re-opening as one after being redrawn freehand.
    NEW.center_lat := NULL;
    NEW.center_lng := NULL;
    NEW.radius_m   := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_areas_sync_geometry
  BEFORE INSERT OR UPDATE ON service_areas
  FOR EACH ROW EXECUTE FUNCTION service_areas_sync_geometry();

REVOKE EXECUTE ON FUNCTION service_areas_sync_geometry()
  FROM public, anon, authenticated;

-- ─── 3. Containment ─────────────────────────────────────────────────────────
--
-- SECURITY DEFINER, and deliberately GRANTed to authenticated — which is the
-- opposite of the usual rule here, so it needs justifying.
--
-- The alternative (INVOKER) looked tidier and is quietly broken: it reads
-- through RLS, so it answers "yes, served" for any session that cannot see the
-- company's rows — a passenger whose get_my_company_id() does not match the
-- ride's company, a guest booking with no session. Those are exactly the
-- inserts worth checking, and the function would be inert for them while
-- looking correct everywhere else. One implementation that behaves differently
-- depending on who calls it is not one implementation.
--
-- As DEFINER it gives the same answer to the booking trigger, to dispatch, to
-- a passenger pre-checking an address, and to service_role. That is what lets
-- the clients grey out an unserved address by CALLING THIS, instead of
-- reimplementing point-in-polygon in JS and drifting from it — the two-sources
-- -of-truth bug this file keeps trying not to repeat.
--
-- Exposing it is safe in a way most definers are not: it takes a company id and
-- returns a boolean about information the company advertises. It returns no
-- rows, writes nothing, and reveals nothing a passenger cannot learn by typing
-- an address into the booking screen. anon is still revoked by name — Supabase
-- default privileges grant EXECUTE to anon and authenticated directly, so
-- "revoke from public" alone leaves both intact (bitten three times).
--
-- ST_Covers, not ST_Contains: a pin dropped exactly on a boundary resolves in
-- the passenger's favour instead of falling into a hairline crack.
--
-- NO AREA FOR THIS END = UNRESTRICTED FOR THIS END. Load-bearing, and note it
-- is per-mode rather than per-company. Two cases it covers:
--   • Day one, nobody has drawn anything, and a default-deny would refuse every
--     booking on the platform (same rollout shape as NULL last_seen_at = live).
--   • A company that has drawn ONLY destination areas (allows_pickup = false on
--     every row). A per-company early-out would leave them with no pickup area
--     at all and refuse every booking they take, silently. Per-mode means the
--     end they have not described stays open. The dashboard should still warn
--     before saving that state — see plan §5 — but the database must not turn
--     it into an outage.

CREATE OR REPLACE FUNCTION company_serves_point(
  p_company_id uuid,
  p_lat        double precision,
  p_lng        double precision,
  p_mode       text              -- 'pickup' | 'dropoff'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    CASE
      WHEN p_company_id IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN true
      WHEN p_mode NOT IN ('pickup', 'dropoff') THEN true
      -- Nothing drawn for this END of the trip -> unrestricted for this end.
      WHEN NOT EXISTS (
        SELECT 1 FROM service_areas
         WHERE company_id = p_company_id
           AND active
           AND (CASE WHEN p_mode = 'pickup'
                     THEN allows_pickup ELSE allows_dropoff END)
      ) THEN true
      ELSE EXISTS (
        SELECT 1 FROM service_areas sa
         WHERE sa.company_id = p_company_id
           AND sa.active
           AND (CASE WHEN p_mode = 'pickup'
                     THEN sa.allows_pickup ELSE sa.allows_dropoff END)
           AND extensions.ST_Covers(
                 sa.area,
                 extensions.ST_SetSRID(
                   extensions.ST_MakePoint(p_lng, p_lat), 4326
                 )::extensions.geography
               )
      )
    END;
$$;

COMMENT ON FUNCTION company_serves_point(uuid, double precision, double precision, text) IS
  'Does this company serve this point for this end of the trip? TRUE when the '
  'company has no active area permitting that end (unrestricted) or when '
  'company_id is NULL. SECURITY DEFINER and granted to authenticated on '
  'purpose: it is the single containment implementation, shared by the booking '
  'trigger and by the clients pre-checking an address.';

REVOKE EXECUTE ON FUNCTION company_serves_point(uuid, double precision, double precision, text)
  FROM public, anon;

GRANT EXECUTE ON FUNCTION company_serves_point(uuid, double precision, double precision, text)
  TO authenticated, service_role;

-- ─── 4. Grants ──────────────────────────────────────────────────────────────
--
-- Supabase's ALTER DEFAULT PRIVILEGES has already granted ALL on this table to
-- anon and authenticated by the time this line runs, and privileges are
-- additive, so a narrower GRANT narrows nothing. Revoke first, then grant the
-- list (learned on driver_locations, 20260769).
--
-- anon gets NOTHING. Worth being explicit about why, because "guest booking is
-- anonymous" makes an anon grant look necessary and it is not: supabase
-- signInAnonymously() mints a JWT whose role is `authenticated` (with
-- is_anonymous = true), so a guest session already reads through the
-- authenticated policy below. The `anon` role here is the pre-session app,
-- which has no company to ask about.

REVOKE ALL ON service_areas FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_areas TO authenticated;

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE service_areas ENABLE ROW LEVEL SECURITY;

-- Staff: full control over their own company's areas.
--
-- auth.uid()-style helpers wrapped in scalar subselects so the planner hoists
-- them to an InitPlan and evaluates once per query, not once per row (20260772).

CREATE POLICY service_areas_staff_all ON service_areas
  FOR ALL TO authenticated
  USING      ((SELECT is_staff()) AND company_id = (SELECT get_my_company_id()))
  WITH CHECK ((SELECT is_staff()) AND company_id = (SELECT get_my_company_id()));

-- Everyone else reads their own company's ACTIVE areas, and only those.
--
-- This is what lets the booking UI grey out an unserved address instead of
-- letting the passenger get all the way to a refused insert, and it is what
-- makes company_serves_point() answer correctly as INVOKER (§3). A company's
-- service map is not secret — it is the thing they advertise.

CREATE POLICY service_areas_read_own_company ON service_areas
  FOR SELECT TO authenticated
  USING (active AND company_id = (SELECT get_my_company_id()));

-- ─── 6. Company-level geography ─────────────────────────────────────────────

ALTER TABLE companies
  -- The onboarding pin: "where is your dispatch office / main stand?". Exists
  -- for the window between a company being created and its first area being
  -- drawn, and as the answer for one that never draws one. Map framing falls
  -- back to it before it falls back to the hardcoded valley constant.
  ADD COLUMN IF NOT EXISTS service_center_lat   double precision,
  ADD COLUMN IF NOT EXISTS service_center_lng   double precision,

  -- Past this trip distance the passenger (and dispatch) get an explicit
  -- "this is an 85 km trip, about $158 — continue?" confirmation.
  --
  -- NOT a rail against the $1,985 ride: the allowlist makes that unreachable.
  -- This catches the bounded-but-surprising case — passenger means Kentville
  -- Mall, taps Halifax Stanfield, and is charged a real $158 for a trip they
  -- did not intend. A confirmation, never a refusal: the trip is legitimate,
  -- the mis-tap is not, and only the passenger can tell them apart.
  ADD COLUMN IF NOT EXISTS long_trip_confirm_km numeric NOT NULL DEFAULT 50;

COMMENT ON COLUMN companies.long_trip_confirm_km IS
  'Trip distance past which booking asks for explicit confirmation. Default 50 '
  'sits above ordinary town work and below an airport run.';
