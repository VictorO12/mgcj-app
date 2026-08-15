-- Close the driver_invites leaks (found 2026-08-15 auditing live RLS).
--
-- Live state before this migration:
--   "anyone can read invite by code"  SELECT  USING (used = false)
--   "anyone can mark invite as used"  UPDATE  USING (used = false) WITH CHECK (used = true)
--
-- Despite its name the SELECT policy has no filter on `code` and no company
-- scope, so any authenticated session could read EVERY unused invite for EVERY
-- company. The bar was lower than it looks: signInAnonymously() (the guest
-- booking path) issues a JWT with the `authenticated` role, so the anon key
-- shipped in the app bundle was enough — no phone, no OTP, no account. An invite
-- code is the only gate on driver registration, so this was a path to
-- registering as a driver at any company on the platform.
--
-- The UPDATE policy let any authenticated user flip every pending invite to
-- used (a one-query denial of driver onboarding), and since WITH CHECK only
-- constrains `used`, rewrite the other columns in the same statement.
--
-- Both policies are already DEAD CODE: 20260701 replaced the client UPDATE with
-- the SECURITY DEFINER mark_invite_used() (which bypasses RLS) but left the
-- policy in place, and after this migration nothing reads the table from a
-- client at all. Dropping them removes reachable surface, not working behaviour.

-- ── 1. One atomic consume, replacing OTPVerifyScreen's direct table read ─────
-- The client used to SELECT the invite (needing the SELECT policy above), check
-- it in JS, then call mark_invite_used() — a check-then-act with a real race:
-- two devices verifying the same code concurrently both passed the check and
-- both registered. Validating and consuming in a single UPDATE ... WHERE
-- used = false makes the winner whoever the row lock picks, and the loser gets
-- 'already_used'.
CREATE OR REPLACE FUNCTION consume_invite_code(p_code text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_invite  record;
BEGIN
  -- Post-OTP only: an anonymous session must never be able to burn a code.
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_authenticated');
  END IF;

  UPDATE driver_invites
     SET used = true
   WHERE code = p_code
     AND used = false
     AND (phone IS NULL OR phone = p_phone)
  RETURNING company_id INTO v_company;

  IF FOUND THEN
    RETURN jsonb_build_object('valid', true, 'company_id', v_company);
  END IF;

  -- Nothing consumed — say why, using the same reason codes the pre-OTP
  -- check_invite_code() returns so the screens can share error copy.
  SELECT used, phone, company_id INTO v_invite FROM driver_invites WHERE code = p_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_found');
  ELSIF v_invite.used AND v_invite.phone IS NOT NULL AND v_invite.phone = p_phone THEN
    -- Idempotent retry by the SAME phone. Consuming now happens BEFORE the
    -- profiles/drivers upserts in OTPVerifyScreen, so a failure after this call
    -- would otherwise burn the code and strand the driver needing a reissue.
    -- A different phone still gets 'already_used', so single-use holds.
    RETURN jsonb_build_object('valid', true, 'company_id', v_invite.company_id);
  ELSIF v_invite.used THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'already_used');
  ELSE
    RETURN jsonb_build_object('valid', false, 'reason', 'phone_mismatch');
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION consume_invite_code(text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION consume_invite_code(text, text) TO authenticated;

-- ── 2. Make the pre-OTP check survive losing the SELECT policy ──────────────
-- check_invite_code() is called from DriverSignUpScreen BEFORE any session
-- exists, so it runs as `anon`. It was applied ad-hoc via the SQL editor and is
-- not in this repo, so its body is unknown here — if it is INVOKER it reads
-- driver_invites through the caller's privileges and would start returning
-- 'not_found' for every code the moment step 3 drops the SELECT policy.
--
-- ALTER rather than CREATE OR REPLACE: this makes it SECURITY DEFINER without
-- touching a body we haven't seen. It only ever returns {valid, reason} — no
-- row data — so it is not an enumeration path. The loop handles the signature
-- being text/text or something else.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = 'check_invite_code'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', fn.sig);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn.sig);
  END LOOP;
END $$;

-- ── 3. Drop the two open policies ───────────────────────────────────────────
-- "admins can manage invites" (FOR ALL, role + company scoped) is untouched —
-- that's how dispatch creates and lists invites from the dashboard.
DROP POLICY IF EXISTS "anyone can read invite by code"  ON driver_invites;
DROP POLICY IF EXISTS "anyone can mark invite as used"  ON driver_invites;

-- ── 4. Retire the id-addressable mark ───────────────────────────────────────
-- mark_invite_used(uuid) marks ANY invite used, by id, for any authenticated
-- caller — the same denial-of-onboarding the dropped UPDATE policy allowed,
-- reachable as long as ids leak. consume_invite_code() supersedes it, and
-- OTPVerifyScreen is its only caller.
DROP FUNCTION IF EXISTS mark_invite_used(uuid);
