-- Read paths for the Service Areas editor.
--
-- Design: .claude/notes/service-areas-plan.md §5
--
-- Two things the dashboard needs that 20260917 deliberately did not provide,
-- because neither is needed to ENFORCE anything — they exist so a human can see
-- what they are drawing.

-- ─── 1. Geometry the browser can actually draw ──────────────────────────────
--
-- PostgREST hands back `area` as EWKB hex ('0106000020E6100000...'), which a
-- browser can do nothing with short of bundling a WKB parser. This view adds
-- GeoJSON alongside.
--
-- Reading goes through the view; WRITING still goes straight at the table, with
-- the client sending EWKT ('SRID=4326;MULTIPOLYGON(((...)))') — verified working
-- through PostgREST 2026-09-17. So there is still exactly one stored geometry
-- and the GeoJSON is derived from it on every read; it cannot drift.
--
-- security_invoker = on so the base table's RLS applies to whoever queries the
-- view, rather than to its owner. Without it this view would hand every
-- company's areas to every authenticated session — the classic way a view
-- launders RLS away.

CREATE OR REPLACE VIEW service_areas_geo
WITH (security_invoker = on) AS
SELECT
  id, company_id, name,
  allows_pickup, allows_dropoff, active,
  shape_kind, center_lat, center_lng, radius_m,
  created_at, updated_at,
  extensions.ST_AsGeoJSON(area)::jsonb AS area_geojson
FROM service_areas;

REVOKE ALL ON service_areas_geo FROM anon, authenticated;
GRANT SELECT ON service_areas_geo TO authenticated;

COMMENT ON VIEW service_areas_geo IS
  'service_areas + area as GeoJSON, for the dashboard editor. Read-only: '
  'writes go to the base table as EWKT.';

-- ─── 2. "What would this have refused?" ─────────────────────────────────────
--
-- The single most important number in the editor, and the reason it is a
-- server-side function rather than a loop in the browser.
--
-- The moment a company draws its FIRST area, every previously-legal ride
-- outside it becomes a refusal — and the refusal is silent, because a turned
-- away passenger just closes the app. This is what stands between an owner and
-- quietly losing their airport business the day they start using the feature.
--
-- It runs company_serves_point() — the same containment the booking path uses.
-- The browser must NOT reimplement this with google.maps.geometry: a preview
-- that disagrees with enforcement is worse than no preview, and that exact
-- client/server split is what produced both the $0.75 ride and the un-surcharged
-- vehicle class.
--
-- Pickup and dropoff are counted SEPARATELY on purpose. Under the allowlist
-- they are different mistakes — a too-tight home polygon versus a destination
-- nobody remembered to add — and a blended count hides which one was just made.

CREATE OR REPLACE FUNCTION service_area_impact(
  p_company_id uuid,
  p_limit      integer DEFAULT 200
)
RETURNS TABLE (
  total            integer,
  pickup_refused   integer,
  dropoff_refused  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- DEFINER, so it must check for itself. Staff only, own company only: these
  -- are ride counts, and the function would otherwise let any authenticated
  -- session size up any company's book of business.
  IF NOT (is_staff() AND p_company_id = get_my_company_id()) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH recent AS (
    SELECT r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng
      FROM rides r
     WHERE r.company_id = p_company_id
     ORDER BY r.created_at DESC
     LIMIT GREATEST(p_limit, 0)
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE NOT company_serves_point(p_company_id, pickup_lat, pickup_lng, 'pickup')
    )::integer,
    count(*) FILTER (
      WHERE NOT company_serves_point(p_company_id, dropoff_lat, dropoff_lng, 'dropoff')
    )::integer
  FROM recent;
END;
$$;

COMMENT ON FUNCTION service_area_impact(uuid, integer) IS
  'How many of a company''s most recent rides the CURRENT service areas would '
  'refuse, split by pickup and dropoff. Staff-only, own company only.';

-- Supabase default privileges grant EXECUTE to anon and authenticated BY NAME,
-- so revoking from public alone leaves both intact. Revoke by name, then grant
-- back only what is wanted.
REVOKE EXECUTE ON FUNCTION service_area_impact(uuid, integer)
  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION service_area_impact(uuid, integer)
  TO authenticated, service_role;
