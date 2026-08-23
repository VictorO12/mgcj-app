-- Store profiles.phone in E.164 (with '+'), and stop handle_new_user from
-- writing it any other way.
--
-- auth.users.phone is stored WITHOUT a leading '+' ('19025550101'), and
-- handle_new_user copied it verbatim into profiles.phone on auth-user INSERT.
-- Everything that looks a passenger up by number uses E.164 WITH the '+'
-- (mgcj-dashboard's toE164(), PhoneEntryScreen's phone_is_registered() call),
-- so those rows matched nothing. Two live consequences:
--
--   * Dispatch booking for an existing customer found no profile and minted a
--     guest for someone who already had an account -- the duplicate-profile
--     path, in production, not hypothetical.
--   * phone_is_registered() returned false for a real account, so a returning
--     passenger was told "This number isn't registered" at login.
--
-- The app half is fixed separately: the passenger upsert in OTPVerifyScreen was
-- gated on `!existing`, which has been dead since this trigger started
-- pre-creating the row, so the E.164 phone and the name typed at sign-up were
-- never written. That gate is removed.

-- ─── 1. Backfill ────────────────────────────────────────────────────────────
-- Verified before writing this: the only affected rows are real, phone-verified
-- accounts. No profile rows exist from abandoned OTP requests, so this cannot
-- promote a junk row into one that phone_is_registered() reports as registered.
UPDATE profiles
   SET phone = '+' || phone
 WHERE phone IS NOT NULL
   AND phone <> ''
   AND left(phone, 1) <> '+';

-- ─── 2. Trigger ─────────────────────────────────────────────────────────────
-- Normalizes at the source, so the row is correct in the window between
-- auth-user creation and the client's upsert.
--
-- `on conflict (id) do nothing` is kept deliberately: this trigger also fires
-- for the anonymous auth user behind a dispatch-created guest, and the caller
-- fills the row in afterwards via upsert(onConflict: 'id').
--
-- role is still hardcoded 'passenger' -- the driver path overwrites it with its
-- own unconditional upsert immediately after. Left alone here on purpose.
--
-- SET search_path added: the previous definition was SECURITY DEFINER without a
-- pinned search_path.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, phone, role)
  VALUES (
    new.id,
    CASE
      WHEN new.phone IS NULL OR new.phone = '' THEN NULL
      WHEN left(new.phone, 1) = '+'            THEN new.phone
      ELSE '+' || new.phone
    END,
    'passenger'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;
