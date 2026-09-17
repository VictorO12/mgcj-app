-- Saved places: the passenger's own Home / Work / named destinations.
--
-- Design: .claude/notes/quick-destinations-plan.md (phase 1)
--
-- Replaces PassengerHomeScreen's hardcoded QUICK_DESTINATIONS constant, which
-- was wrong in two ways that are worth recording because they are the reason
-- this table exists:
--
--   1. It stored ADDRESS STRINGS, not coordinates. Tapping a "quick"
--      destination called searchPlaces() -> Places Autocomplete, then the
--      passenger still had to tap a prediction -> Places Details. Two billed
--      Maps calls and two taps, and it could resolve to the wrong branch of a
--      chain. A row here carries lat/lng, so a tap sets the destination
--      directly and goes straight to the confirm sheet: zero Places calls.
--   2. The four entries were Annapolis Valley landmarks, hardcoded, so they
--      would have shipped verbatim to every future customer in every town.
--
-- Deliberately NOT built (2026-09-15): a company-level seed/curated list. A
-- passenger with nothing saved and no ride history now sees no chip row at all,
-- rather than someone else's town's landmarks.

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE passenger_places (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  passenger_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- 'home' and 'work' are ROLES, not just two custom names with nicer icons:
  -- the suggestion engine (phase 4) reads them as anchors ("near home at
  -- 08:00 on a weekday"), and the UI pins them ahead of everything else.
  kind          text NOT NULL DEFAULT 'custom'
                CHECK (kind IN ('home', 'work', 'custom')),

  -- The passenger's own label, for kind='custom' only. Home/Work take their
  -- name from the kind so renaming one cannot break the anchor above.
  name          text,

  -- The full string, exactly as rides.dropoff_address wants it. The civic
  -- number lives here because the DRIVER needs it — same reasoning as the
  -- comment in PassengerHomeScreen.selectPlace.
  address       text NOT NULL,

  -- The short form shown in the pickup/dropoff input rows and on the chip.
  -- Places structured_formatting.main_text, i.e. "Valley Regional Hospital".
  display       text NOT NULL,

  lat           double precision NOT NULL,
  lng           double precision NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Ordering signal for the chip row, and nothing else. Null until first use.
  last_used_at  timestamptz,

  -- A name is required for a custom place and meaningless for the other two.
  CONSTRAINT passenger_places_name_matches_kind
    CHECK ((kind = 'custom' AND name IS NOT NULL) OR (kind <> 'custom'))
);

-- At most one Home and one Work each. Partial unique indexes rather than a
-- constraint because 'custom' must stay unlimited.
CREATE UNIQUE INDEX passenger_places_one_home
  ON passenger_places (passenger_id) WHERE kind = 'home';
CREATE UNIQUE INDEX passenger_places_one_work
  ON passenger_places (passenger_id) WHERE kind = 'work';

-- Saving the same place twice is the obvious way this list turns to noise.
-- Dedupe on ROUNDED COORDINATES, not on the address string: that string comes
-- from a Places prediction the passenger picked, so the same hospital arrives
-- spelled several different ways. 4dp is ~11m, which separates two shops in a
-- plaza but not two attempts at the same door.
CREATE UNIQUE INDEX passenger_places_one_per_spot
  ON passenger_places (
    passenger_id,
    round(lat::numeric, 4),
    round(lng::numeric, 4)
  );

-- The only read: "this passenger's places, most recently used first".
CREATE INDEX passenger_places_passenger_idx
  ON passenger_places (passenger_id, last_used_at DESC NULLS LAST);

COMMENT ON TABLE passenger_places IS
  'Passenger-saved destinations. No FK points here from rides: rides snapshot '
  'their own dropoff_address and coords at booking, so renaming or deleting a '
  'place must never rewrite ride history (same reasoning as completed_at).';

-- ─── 2. Cap ─────────────────────────────────────────────────────────────────
--
-- Not a product limit anyone reaches — a guard so a retry loop or a bored user
-- cannot write thousands of rows under one passenger.

CREATE OR REPLACE FUNCTION enforce_passenger_places_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT count(*) FROM passenger_places
       WHERE passenger_id = NEW.passenger_id) >= 20 THEN
    RAISE EXCEPTION 'passenger_places limit reached (20)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER passenger_places_cap
  BEFORE INSERT ON passenger_places
  FOR EACH ROW EXECUTE FUNCTION enforce_passenger_places_cap();

-- Definer-or-not, this is a trigger function and nothing should be able to call
-- it directly. Supabase's default privileges grant EXECUTE to anon and
-- authenticated BY NAME, so revoking from public alone leaves both intact.
REVOKE EXECUTE ON FUNCTION enforce_passenger_places_cap()
  FROM public, anon, authenticated;

-- ─── 3. Grants ──────────────────────────────────────────────────────────────
--
-- Supabase's ALTER DEFAULT PRIVILEGES has already granted ALL on this table to
-- anon and authenticated by the time this line runs, and privileges are
-- additive — so a narrower GRANT narrows nothing. The only route to a list is
-- revoke first, then re-grant the list (learned on driver_locations, 20260769).
--
-- anon gets nothing at all: an anonymous session has no saved places by
-- definition, and dispatch-created guest passengers never hold a session.

REVOKE ALL ON passenger_places FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON passenger_places TO authenticated;

-- ─── 4. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE passenger_places ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs. A saved place is a home address: there is no
-- staff read here, and dispatch has no business seeing one.
--
-- auth.uid() is wrapped in a scalar subselect so the planner hoists it to an
-- InitPlan and evaluates it once per query instead of once per row (20260772).

CREATE POLICY passenger_places_select ON passenger_places
  FOR SELECT TO authenticated
  USING (passenger_id = (SELECT auth.uid()));

CREATE POLICY passenger_places_insert ON passenger_places
  FOR INSERT TO authenticated
  WITH CHECK (passenger_id = (SELECT auth.uid()));

-- WITH CHECK as well as USING: without it a passenger could hand a row to
-- somebody else by updating passenger_id.
CREATE POLICY passenger_places_update ON passenger_places
  FOR UPDATE TO authenticated
  USING (passenger_id = (SELECT auth.uid()))
  WITH CHECK (passenger_id = (SELECT auth.uid()));

CREATE POLICY passenger_places_delete ON passenger_places
  FOR DELETE TO authenticated
  USING (passenger_id = (SELECT auth.uid()));
