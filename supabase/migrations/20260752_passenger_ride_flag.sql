-- ═══════════════════════════════════════════════════════════════════════════
-- Passenger escalation on a live ride  (E7)
--
-- A driver who mis-marks pickup puts a ride in_progress with the passenger
-- never aboard. The passenger then has no cancel (deliberate — see below), no
-- rebooking, and no way to tell anyone. This adds the missing channel.
--
-- It is a FLAG, never a cancel. Passenger-initiated cancellation stays blocked
-- mid-ride on purpose: a passenger could otherwise cancel near the end of a
-- trip to dodge the fare, and a driver could propose "cancel the $20 and give
-- me $15 cash". settle-ride's PASSENGER_CANCELLABLE already encodes that and
-- is untouched here. Dispatch — who CAN cancel mid-ride, and whose every
-- cancel is attributed in dispatch_events — resolves the ride.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. The flag itself ────────────────────────────────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS passenger_flagged_at       timestamptz,
  ADD COLUMN IF NOT EXISTS passenger_flag_updated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS passenger_flag_reasons     text[],
  ADD COLUMN IF NOT EXISTS passenger_flag_note        text,
  ADD COLUMN IF NOT EXISTS passenger_flag_resolved_at timestamptz;

COMMENT ON COLUMN rides.passenger_flagged_at IS
  'When the CURRENT unresolved escalation episode was opened. Not moved by later flags on the same episode.';
COMMENT ON COLUMN rides.passenger_flag_updated_at IS
  'Most recent flag within the current episode. Dispatch sorts on this; passenger_flagged_at answers "how long outstanding".';
COMMENT ON COLUMN rides.passenger_flag_reasons IS
  'Accumulating, deduped reason codes for the current episode. An array rather than one column because a situation develops — a passenger who says "the driver never came" and later "I feel unsafe" is telling dispatch two things, and overwriting loses the first.';
COMMENT ON COLUMN rides.passenger_flag_resolved_at IS
  'Set by dispatch when the flag is dealt with. Kept rather than clearing the flag, so the escalation stays in the record.';

-- Columns on `rides`, not a new table, so the dashboard's existing Realtime
-- subscription on `rides` carries the flag with no new channel, and no new RLS
-- or post-Oct-2026 GRANT block is needed.

-- Deliberately NOT added to guard_ride_route_fields' denylist. That trigger is
-- SECURITY DEFINER but reads auth.role(), which still returns 'authenticated'
-- inside the definer function below — so freezing these columns would block
-- the very write path this migration creates. The flag is also the one thing
-- on `rides` where a direct client write is harmless: it resets nothing, moves
-- no money, and starts no pipeline. The RPC is the app's path because it
-- validates the reason and stamps server time, not because it is a boundary.

-- ─── 2. Dispatch's phone number ────────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN companies.phone IS
  'Dispatch phone number, surfaced to passengers escalating a live ride. Editable in the dashboard Settings → company form.';

-- ─── 3. Reading that phone, without re-opening a closed leak ───────────────
-- Passengers have NO profiles.company_id (only drivers get one, from their
-- invite), so companies_select — `id = get_my_company_id()` — returns them
-- nothing. Widening that policy is not an option: its passenger arm is exactly
-- the cross-tenant leak 20260745 closed, which exposed stripe_account_id and
-- platform_fee_percent to every passenger on the platform.
--
-- So: a definer function returning ONE column, for ONE ride the caller owns.
-- Strictly narrower than any policy change could be.
CREATE OR REPLACE FUNCTION get_ride_dispatch_phone(p_ride_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  SELECT c.phone INTO v_phone
  FROM rides r
  JOIN companies c ON c.id = r.company_id
  WHERE r.id = p_ride_id
    AND (r.passenger_id = auth.uid() OR r.driver_id = auth.uid());

  RETURN v_phone;  -- NULL when not yours, or when the company has none set
END;
$$;

-- ─── 4. Raising the flag ───────────────────────────────────────────────────
-- SECURITY DEFINER, so it bypasses RLS. That matters beyond validation: this
-- repo has no migration creating a passenger UPDATE policy on `rides`, and per
-- the migration-files-are-not-applied-state rule the live policy set cannot be
-- confirmed from the repo. A definer write does not depend on the answer.
CREATE OR REPLACE FUNCTION flag_ride(
  p_ride_id uuid,
  p_reasons text[],
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ride     rides%ROWTYPE;
  v_phone    text;
  v_open     boolean;
  v_reasons  text[];
  v_note     text;
BEGIN
  IF p_reasons IS NULL OR array_length(p_reasons, 1) IS NULL THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ride not found';
  END IF;

  IF v_ride.passenger_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not your ride';
  END IF;

  -- Only a ride that is still happening. A completed/cancelled ride has
  -- ride_reviews and driver_reports for after-the-fact complaints; this
  -- channel is for a passenger who needs help right now.
  IF v_ride.status NOT IN ('offered','assigned','driver_arriving','in_progress') THEN
    RAISE EXCEPTION 'This ride is not in progress';
  END IF;

  -- Re-flagging is allowed and ACCUMULATES rather than overwriting. Reasons
  -- are deduped, so the app can pre-tick what has already been sent and a
  -- passenger cannot report the same thing twice. Deliberately NOT single-shot
  -- — the one-report-per-ride lock on driver_reports is part of why that modal
  -- fails this case.
  --
  -- "Episode" semantics: an unresolved flag accumulates; once dispatch
  -- resolves, the next flag starts clean. Without the reset, reasons from a
  -- handled problem would haunt a later, unrelated one for the whole ride.
  v_open := v_ride.passenger_flagged_at IS NOT NULL
            AND (v_ride.passenger_flag_resolved_at IS NULL
                 OR v_ride.passenger_flag_resolved_at < v_ride.passenger_flagged_at);

  IF v_open THEN
    SELECT array_agg(DISTINCT r ORDER BY r)
      INTO v_reasons
      FROM unnest(coalesce(v_ride.passenger_flag_reasons, '{}') || p_reasons) AS r;
    -- Notes append: a second note is extra information, not a correction.
    v_note := NULLIF(btrim(concat_ws(E'\n',
                NULLIF(btrim(coalesce(v_ride.passenger_flag_note, '')), ''),
                NULLIF(btrim(coalesce(p_note, '')), ''))), '');
  ELSE
    SELECT array_agg(DISTINCT r ORDER BY r) INTO v_reasons FROM unnest(p_reasons) AS r;
    v_note := NULLIF(btrim(coalesce(p_note, '')), '');
  END IF;

  UPDATE rides
     SET passenger_flagged_at       = CASE WHEN v_open THEN v_ride.passenger_flagged_at
                                           ELSE now() END,
         passenger_flag_updated_at  = now(),
         passenger_flag_reasons     = v_reasons,
         passenger_flag_note        = v_note,
         passenger_flag_resolved_at = NULL
   WHERE id = p_ride_id;

  SELECT c.phone INTO v_phone FROM companies c WHERE c.id = v_ride.company_id;

  RETURN jsonb_build_object(
    'ok', true,
    'dispatch_phone', v_phone,
    'reasons', to_jsonb(v_reasons)
  );
END;
$$;

-- ─── 5. Grants ─────────────────────────────────────────────────────────────
-- The `revoke execute from public, anon, authenticated` convention in
-- CLAUDE.md is for SERVICE-ROLE-ONLY definer functions (reap_stale_drivers).
-- These two are the opposite: they must be callable by every passenger,
-- including an anonymous guest-booking session, which carries the
-- `authenticated` role. Applying the revoke pattern here would silently kill
-- both. Each function authorizes its own caller against the ride instead.
REVOKE EXECUTE ON FUNCTION get_ride_dispatch_phone(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION flag_ride(uuid, text[], text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION get_ride_dispatch_phone(uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION flag_ride(uuid, text[], text) TO authenticated;

-- ─── 6. Cleanup from the first cut of this migration ───────────────────────
-- This file was revised in place after an initial run (reasons went from a
-- single text column to an accumulating text[]). CREATE OR REPLACE does not
-- replace a function whose SIGNATURE changed — it creates a second overload —
-- so the old one has to go by name, or a stale flag_ride(uuid, text, text)
-- lingers writing a column nothing reads.
--
-- Both statements are no-ops on a database that only ever saw the final
-- version. Safe to re-run.
DROP FUNCTION IF EXISTS flag_ride(uuid, text, text);
ALTER TABLE rides DROP COLUMN IF EXISTS passenger_flag_reason;
