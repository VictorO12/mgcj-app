-- Guest passengers: explicit is_guest flag, and claim-on-signup without merging.
--
-- Dispatch creates a shell "guest" profile when booking for someone who has no
-- account. Previously, when that person later signed up, merge_guest_profile()
-- moved their entire ride history onto the new profile. That function was an
-- anon-callable account-takeover primitive and was dropped in 20260757.
--
-- The replacement does NOT merge history. The guest row keeps its completed
-- rides (so dispatch records, completed_at and platform_fee_percent_at_completion
-- are untouched -- no revenue re-bucketing, cf. the 2026-06-27 incident) and
-- gives up its phone number. Only rides that are still *happening* move, because
-- a passenger standing on the curb must be able to see the ride they are waiting
-- for; nobody needs last month's receipts moved.

-- ─── 1. is_guest ────────────────────────────────────────────────────────────
-- Explicit, rather than inferring from auth.users.is_anonymous. That inference
-- works today only by accident: guests are the sole producer of anonymous users
-- (signInAnonymously has exactly one call site, mgcj-dashboard's
-- createManualBooking). It would break the moment guest creation moves
-- server-side, since auth.admin.createUser() yields is_anonymous = false --
-- which would flip phone_is_registered() to true for guests and dead-end them
-- at "This number isn't registered".

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false;

-- Phone of a retired guest row, moved off `phone` so it stops colliding with
-- the real profile while staying visible to dispatch on historic rides.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS guest_phone text;

COMMENT ON COLUMN profiles.is_guest IS
  'Shell profile created by dispatch for an unregistered passenger. Has an auth.users row (profiles_id_fkey requires one) but no login credential.';

-- ─── 2. Backfill ────────────────────────────────────────────────────────────
UPDATE profiles p
   SET is_guest = true
  FROM auth.users u
 WHERE u.id = p.id
   AND u.is_anonymous
   AND p.role = 'passenger'
   AND p.is_guest IS DISTINCT FROM true;

-- ─── 3. Structural guarantee against duplicates ─────────────────────────────
-- Two profiles on one phone made maybeSingle() return `data: null` with an
-- error the dashboard discarded, sending it into the guest-creation branch and
-- minting yet another duplicate on every booking. The client now surfaces that
-- error; this stops the state arising in the first place.
-- Guests are excluded (they are the legitimate second row until retired), as
-- are drivers/admins, who reach signup through a different path.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_real_passenger_per_phone
  ON profiles (phone)
  WHERE role = 'passenger' AND is_guest = false AND phone IS NOT NULL;

-- ─── 4. phone_is_registered ─────────────────────────────────────────────────
-- Deliberately NOT filtered by role: DriverWelcomeScreen and DriverSignUpScreen
-- both route to PhoneEntryScreen, so this answers for returning drivers too.
-- Adding role='passenger' would tell every driver their number isn't registered.
-- Now keyed on is_guest rather than the auth.users.is_anonymous join (see 1).
-- SET search_path added: it was missing on the previous definition.
CREATE OR REPLACE FUNCTION phone_is_registered(p_phone text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.phone = p_phone
       AND p.is_guest IS NOT TRUE
  );
$$;

-- ─── 5. claim_guest_rides ───────────────────────────────────────────────────
-- Takes NO arguments. Both the caller and the phone number come from the
-- caller's own verified JWT, so there is no input to aim at a stranger. That
-- is the structural difference from merge_guest_profile, whose caller-supplied
-- p_old_id let anyone delete any profile.
--
-- Must run AFTER the caller's real profile row exists: rides.passenger_id is
-- FK'd to profiles(id).
CREATE OR REPLACE FUNCTION claim_guest_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_phone text := auth.jwt() ->> 'phone';
  v_moved integer := 0;
  v_n     integer;
  g       record;
BEGIN
  IF v_uid IS NULL OR v_phone IS NULL OR v_phone = '' THEN
    RETURN 0;
  END IF;

  -- Supabase stores the phone claim WITHOUT a leading '+' ('19025550101'),
  -- while profiles.phone is E.164 WITH it. Matching only one form silently
  -- does nothing -- the same failure the old merge path already had.
  IF left(v_phone, 1) <> '+' THEN
    v_phone := '+' || v_phone;
  END IF;

  -- A loop, not a single row: if the duplicate-proliferation bug ever fired
  -- there may be several guest rows on this number, and all of them drain.
  FOR g IN
    SELECT id FROM profiles
     WHERE is_guest
       AND role = 'passenger'
       AND phone = v_phone
       AND id <> v_uid
  LOOP
    UPDATE rides
       SET passenger_id = v_uid
     WHERE passenger_id = g.id
       AND status IN ('scheduled','pending','offered',
                      'assigned','driver_arriving','in_progress');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved + v_n;

    -- Retire the row: it keeps its completed rides and its name, loses the
    -- phone so it can never match a dispatch lookup again.
    UPDATE profiles
       SET guest_phone = COALESCE(guest_phone, phone),
           phone       = NULL
     WHERE id = g.id;
  END LOOP;

  RETURN v_moved;
END;
$$;

-- 20260734's lesson, applied: Supabase default privileges grant EXECUTE
-- directly to anon and authenticated, so `revoke from public` alone leaves a
-- definer function callable by anon. Revoke from those roles BY NAME first.
-- (merge_guest_profile, dropped in 20260757, was the second function to be
-- reachable by anon because this was skipped.)
REVOKE EXECUTE ON FUNCTION claim_guest_rides() FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION claim_guest_rides() TO authenticated;
