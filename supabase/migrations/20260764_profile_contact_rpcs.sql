-- ═══════════════════════════════════════════════════════════════════════════
-- Definer readers for the private profile columns
--
-- Prep for 20260765, which drops the table-wide SELECT grant on profiles and
-- re-grants a column list WITHOUT phone, guest_phone, email, student_email and
-- stripe_customer_id. This migration adds the functions that let the LEGITIMATE
-- readers keep working; it grants no new access on its own and is safe to apply
-- ahead of the revoke.
--
-- Why any of this exists: verified live 2026-08-22, a driver read a passenger's
-- real phone number off `profiles` through the app's own query, on a ride that
-- had completed two months earlier. `shares_ride_with()` — the policy branch
-- that admits it — has no status filter and no time bound, and it is symmetric,
-- so the passenger read the driver's personal number back. Row access is
-- deliberately left alone (ride history and DriverProfileSheet need the name
-- and avatar); only the columns move behind these functions.
--
-- Plan + live evidence: .claude/notes/g3-phone-column-revoke-plan.md
--                       .claude/notes/g3-profiles-phone-exposure-check.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. profile_phone(uuid) — one number, for a reader entitled to it ───────
--
-- Entitlement is: yourself, or staff at the company that the person actually
-- belongs to / has ridden with. NOT a bare is_staff(): the existing policy
-- pairs is_staff() with `company_id = get_my_company_id() OR role = 'passenger'`
-- and that second half lets a dispatcher at any company read every passenger on
-- the platform. Reproducing it here would move the leak rather than close it.
--
-- Drivers are not staff, so they fall through both branches to NULL — which is
-- the exact relationship the whole change exists to sever. Every mis-nesting of
-- the and/or below FAILS OPEN, so the denials are tested explicitly in
-- g3-profiles-phone-exposure-check.sql §9, not just the grants.
CREATE OR REPLACE FUNCTION public.profile_phone(p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
BEGIN
  IF p_profile_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_profile_id = auth.uid() THEN
    -- coalesce, not `phone`: see the guest_phone note on the staff branch.
    SELECT coalesce(phone, guest_phone) INTO v_phone
      FROM profiles WHERE id = p_profile_id;
    RETURN v_phone;
  END IF;

  IF is_staff() AND (
       EXISTS (SELECT 1 FROM profiles p
                WHERE p.id = p_profile_id
                  AND p.company_id = get_my_company_id())
       OR EXISTS (SELECT 1 FROM rides r
                   WHERE r.company_id = get_my_company_id()
                     AND (r.passenger_id = p_profile_id
                       OR r.driver_id    = p_profile_id))
     ) THEN
    -- coalesce because claim_guest_rides() moves a retiring guest's number off
    -- `phone` onto `guest_phone` when they sign up for real, so their historic
    -- rides would otherwise show dispatch a blank number. 20260758 moved the
    -- column for exactly this and nothing has read it since; this is it.
    SELECT coalesce(phone, guest_phone) INTO v_phone
      FROM profiles WHERE id = p_profile_id;
    RETURN v_phone;
  END IF;

  -- Fail closed. NULL, not an exception: a dispatcher looking at a ride whose
  -- counterparty they may not see should get a blank field, not a broken page.
  RETURN NULL;
END;
$$;

-- ─── 2. profile_phones(uuid[]) — the same answer, in one round trip ─────────
--
-- The dashboard resolves phones a whole ride list at a time (batchProfiles);
-- per-row calls would be N round trips on every refresh of a live board.
-- Deliberately delegates to profile_phone() rather than repeating the
-- entitlement SQL — two copies of that predicate WILL drift, and the copy that
-- drifts is the one that fails open.
CREATE OR REPLACE FUNCTION public.profile_phones(p_profile_ids uuid[])
RETURNS TABLE (id uuid, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, public.profile_phone(u.id)
    FROM unnest(coalesce(p_profile_ids, '{}'::uuid[])) AS u(id);
$$;

-- ─── 3. my_private_profile() — the self bundle ─────────────────────────────
--
-- Every withheld column, for yourself only. There is no argument: the caller is
-- auth.uid() and there is nothing to point at a stranger. That is the same
-- lesson as claim_guest_rides() replacing merge_guest_profile(), which took
-- both ids from the caller and was an account-takeover primitive (20260757).
--
-- push_token is included even though the column stays GRANTED for now, so that
-- withholding it later is a one-line change to the grant list rather than
-- another client edit. Pending: this project sends to Expo with no
-- Authorization header (_shared/push.ts:120), which means possession of a token
-- is enough to push to that device — and a granted push_token is readable by
-- the ride counterparty through shares_ride_with.
CREATE OR REPLACE FUNCTION public.my_private_profile()
RETURNS TABLE (
  phone              text,
  email              text,
  student_email      text,
  stripe_customer_id text,
  push_token         text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(p.phone, p.guest_phone),
         p.email,
         p.student_email,
         p.stripe_customer_id,
         p.push_token
    FROM profiles p
   WHERE p.id = auth.uid();
$$;

-- ─── 4. find_passenger_by_phone(text) — dispatch's booking lookup ──────────
--
-- The one function here that answers a question ABOUT a phone number rather
-- than returning one, and so the one that could be an enumeration oracle. It is
-- staff-only, and it returns id/name — never a number — so it cannot be used to
-- read anything that isn't already known to the caller.
--
-- Mirrors create-guest-passenger's findPassenger() exactly, and must keep
-- mirroring it: matches `phone` ONLY, never guest_phone. claim_guest_rides()
-- nulls a retiring guest's phone, which is what makes a signed-up former guest
-- resolve to their real profile instead of their retired shell. Matching
-- guest_phone here would resurrect the retired row as a booking target.
--
-- The role filter is null-tolerant because profiles_role_check is a CHECK and
-- NULL satisfies a CHECK, so a role-less row predating the constraint exists;
-- a bare equality would miss it and mint a duplicate guest for a number that
-- already has one. Drivers and admins are excluded — booking one as the
-- passenger is the bug the filter prevents.
CREATE OR REPLACE FUNCTION public.find_passenger_by_phone(p_phone text)
RETURNS TABLE (id uuid, name text, is_guest boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digits text;
  v_phone  text;
BEGIN
  IF NOT is_staff() THEN
    RETURN;               -- zero rows, not an exception
  END IF;

  -- Normalize HERE rather than trusting the caller. create-guest-passenger
  -- re-runs toE164() server-side for the same reason: profiles.phone is E.164
  -- with a leading '+' everywhere, and a lookup that misses mints a duplicate
  -- guest for a number that already has one. Two callers normalizing
  -- independently is two things that can drift; this is the last word.
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  IF length(v_digits) = 10 THEN
    v_phone := '+1' || v_digits;
  ELSIF length(v_digits) = 11 AND left(v_digits, 1) = '1' THEN
    v_phone := '+' || v_digits;
  ELSE
    RETURN;                -- not a number we can resolve; say nothing
  END IF;

  RETURN QUERY
    SELECT p.id, p.name, p.is_guest
      FROM profiles p
     WHERE p.phone = v_phone
       AND (p.role = 'passenger' OR p.role IS NULL)
     LIMIT 1;
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
-- `revoke from public` alone is NOT enough. Supabase default privileges grant
-- EXECUTE directly to anon and authenticated, which is a distinct grant that
-- survives revoking PUBLIC — that is how merge_guest_profile stayed callable by
-- anon (20260757), and how ops_revenue returned every company's book of
-- business to anyone holding the publishable key (20260762). Revoke BY NAME.
REVOKE EXECUTE ON FUNCTION public.profile_phone(uuid)             FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.profile_phones(uuid[])          FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.my_private_profile()            FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.find_passenger_by_phone(text)   FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.profile_phone(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.profile_phones(uuid[])           TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_private_profile()             TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_passenger_by_phone(text)    TO authenticated;
