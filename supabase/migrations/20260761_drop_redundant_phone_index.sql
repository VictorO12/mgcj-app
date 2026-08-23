-- Drop profiles_one_real_passenger_per_phone (added in 20260758).
--
-- It was written to guarantee "at most one real passenger profile per phone
-- number". That invariant was already enforced, and more strictly, by the
-- pre-existing GLOBAL unique constraint profiles_phone_key on profiles.phone --
-- which 20260758 was written without knowing about. Two overlapping
-- constraints on the same column, one a strict subset of the other, is a
-- future misreading waiting to happen: the partial index looks like the thing
-- protecting the invariant while profiles_phone_key is what actually fires
-- (as it did on POST /otp, see 20260760).

DROP INDEX IF EXISTS profiles_one_real_passenger_per_phone;
