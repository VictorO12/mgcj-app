-- Pre-session check for the dispatch dashboard login: does this phone number
-- belong to a dispatch account (admin or dispatcher)?
--
-- The dashboard's LoginPage previously sent an SMS OTP to ANY number entered,
-- then relied on App.tsx to show "Access denied. Staff only." after the person
-- had already signed in. That burns a Twilio verification on passengers /
-- drivers / strangers and drags them through the OTP step for no reason. This
-- lets LoginPage check membership BEFORE sending the code and stop non-dispatch
-- numbers at the phone step.
--
-- SECURITY DEFINER so it runs pre-session (no JWT) without RLS blocking the
-- profiles read — same pattern as phone_is_registered() used by the mobile app.
--
-- Gated on role only, NOT is_active: a deactivated dispatcher still has a real
-- account, so we let them through here and let App.tsx show the accurate
-- "contact an admin to restore access" screen rather than a misleading
-- "no account" at this step.

CREATE OR REPLACE FUNCTION phone_is_dispatch(p_phone text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE phone = p_phone
      AND role IN ('admin', 'dispatcher')
  );
$$;

GRANT EXECUTE ON FUNCTION phone_is_dispatch(text) TO anon, authenticated;
