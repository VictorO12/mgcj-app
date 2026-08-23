-- handle_new_user must not write profiles.phone.
--
-- Regression introduced by 20260759 and caught in live testing: signup with a
-- number that has a dispatch-created guest row failed with a 500 on POST /otp,
--   duplicate key value violates unique constraint "profiles_phone_key"
-- which is a pre-existing GLOBAL unique constraint on profiles.phone.
--
-- Before 20260759 this collision was masked by the very bug that migration
-- fixed: the guest row held '+19025550101' while the trigger inserted
-- '19025550101', so the two never collided. Normalizing the trigger made them
-- the same string, and the trigger fires when the OTP is REQUESTED -- before
-- the passenger has verified anything and long before claim_guest_rides() gets
-- a chance to retire the guest row.
--
-- Fix: the trigger creates the row (which must exist -- rides.passenger_id and
-- others are FK'd to profiles.id) but leaves phone NULL. The phone is then
-- written by whoever actually knows it, always in E.164:
--
--   * OTPVerifyScreen passenger upsert  (route param, with '+')
--   * OTPVerifyScreen driver upsert     (route param, with '+')
--   * mgcj-dashboard createManualBooking (toE164(), with '+')
--
-- All three already upsert on conflict (id), so none of them depended on the
-- trigger's copy. Single writer, one format, no window where the row holds a
-- number in the wrong shape.
--
-- Client-side counterpart: claim_guest_rides() now runs BEFORE the passenger
-- upsert in OTPVerifyScreen, so the guest row has released the number by the
-- time the real profile claims it.
--
-- Note: profiles_one_real_passenger_per_phone (20260758) is redundant with
-- profiles_phone_key, which is stricter. Left in place -- it documents the
-- intent and costs nothing -- but profiles_phone_key is what actually fires.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- phone deliberately omitted: see header.
  INSERT INTO public.profiles (id, role)
  VALUES (new.id, 'passenger')
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;
