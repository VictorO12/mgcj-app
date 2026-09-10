-- Driver breadcrumb history — the half of whole-shift tracking that actually
-- displaces a GPS tracker.
--
-- Design: .claude/notes/background-location-shift-tracking.md (step 2)
--
-- Live position needs no schema at all: drivers.current_lat/current_lng already
-- carries it, and the background location task from step 1 keeps it fresh. This
-- table answers the OTHER question a taxi owner asks, and the one tracker
-- vendors actually sell: "where was car 7 at 2pm Tuesday, what route did it
-- take, how long did it sit idle".

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE driver_locations (
  id           bigserial PRIMARY KEY,

  driver_id    uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,

  -- Denormalised from profiles.company_id rather than joined. Every read of
  -- this table is tenant-scoped, it is the leading index column, and the join
  -- would run per-row on the hottest table in the schema. The INSERT policy
  -- pins it to the caller's own company so it cannot be spoofed.
  company_id   uuid NOT NULL REFERENCES companies(id),

  -- Set when the fix was taken during a fare. Null while idle. This is what
  -- makes "replay this ride" a WHERE clause instead of a time-range guess, and
  -- it is the column a dispute ("the driver took the long way") is answered
  -- from. ON DELETE SET NULL, not CASCADE: a deleted ride must not silently
  -- take a driver's shift history with it.
  ride_id      uuid REFERENCES rides(id) ON DELETE SET NULL,

  -- WHEN THE FIX WAS TAKEN, from the device — not when the row was inserted.
  -- Batches arrive late (a dead zone, a backgrounded upload), so stamping on
  -- insert would draw a straight teleport line through exactly the gap the
  -- history exists to explain.
  recorded_at  timestamptz NOT NULL,

  -- When we received it. Kept alongside recorded_at, one extra column, because
  -- a device with a wrong clock is otherwise indistinguishable from a genuine
  -- upload delay — and the difference matters when the history is evidence.
  received_at  timestamptz NOT NULL DEFAULT now(),

  lat          double precision NOT NULL,
  lng          double precision NOT NULL,

  -- All three straight off the GPS fix, all genuinely absent sometimes: heading
  -- and speed are null when stationary (see courseOrNull in the app), accuracy
  -- is null on some Android providers.
  heading      double precision,
  speed        double precision,
  accuracy     double precision
);

-- Every read is "this company, this driver, this window".
CREATE INDEX driver_locations_driver_time_idx
  ON driver_locations (company_id, driver_id, recorded_at DESC);

-- Ride replay: "draw the path of ride X".
CREATE INDEX driver_locations_ride_idx
  ON driver_locations (ride_id, recorded_at)
  WHERE ride_id IS NOT NULL;

-- The prune below scans on recorded_at across all companies.
CREATE INDEX driver_locations_recorded_at_idx ON driver_locations (recorded_at);

-- ─── 2. Grants ──────────────────────────────────────────────────────────────
--
-- Tables created after 2026-10-30 are not reachable through PostgREST without
-- explicit grants. No UPDATE and no DELETE to anyone: a breadcrumb is an
-- immutable observation, and a driver being able to edit or erase their own
-- history would remove the only reason a company trusts it.

GRANT SELECT, INSERT ON driver_locations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE driver_locations_id_seq TO authenticated;

-- ─── 3. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE driver_locations ENABLE ROW LEVEL SECURITY;

-- A driver writes only their own fixes, only into their own company. Both
-- halves matter: without the company pin a driver could stamp rows with another
-- company's id and pollute a tenant they cannot even read.
CREATE POLICY driver_locations_insert ON driver_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    driver_id = auth.uid()
    AND company_id = get_my_company_id()
  );

-- A driver can read their own trail. They are the subject of it; being able to
-- see what is recorded about you is the baseline the privacy policy promises.
CREATE POLICY driver_locations_select_own ON driver_locations
  FOR SELECT TO authenticated
  USING (driver_id = auth.uid());

-- Dispatch and admins read their whole company. is_staff() rather than
-- role = 'admin': dispatchers do the ride ops this exists to support.
CREATE POLICY driver_locations_select_staff ON driver_locations
  FOR SELECT TO authenticated
  USING (is_staff() AND company_id = get_my_company_id());

-- Passengers get NOTHING here, deliberately. A passenger sees the driver's live
-- position during their own ride (drivers.current_lat/lng) and that is the
-- entire legitimate need; history would let anyone who ever booked a ride
-- reconstruct a driver's movements.

-- ─── 4. Retention ───────────────────────────────────────────────────────────
--
-- Not optional. This project has already come close to the 2GB disk limit on
-- pg_cron/pg_net audit tables that nothing pruned. Rough volume: ~2,000 fixes
-- per driver-shift, so ~600k rows/month at 11 drivers (fine) and ~22M/month at
-- a 300-car fleet (not fine — that tier needs partitioning or downsampling
-- BEFORE it is sold, see the design note).

CREATE OR REPLACE FUNCTION public.prune_driver_locations(p_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM driver_locations
   WHERE recorded_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Supabase's default privileges grant EXECUTE on new functions directly to
-- anon and authenticated. "REVOKE FROM public" alone does NOT remove those —
-- they must be named. This has bitten this project three times; without it any
-- session holding the app's anon key could erase every company's history.
REVOKE EXECUTE ON FUNCTION public.prune_driver_locations(integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_driver_locations(integer) TO service_role;

-- Nightly, off-peak for America/Halifax. Same pattern as cleanup-cron-logs.
-- Run this separately if the SQL editor refuses cron.schedule inside the
-- migration transaction.
SELECT cron.schedule(
  'prune-driver-locations',
  '20 3 * * *',
  $$SELECT public.prune_driver_locations(30);$$
);
