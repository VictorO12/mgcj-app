-- Robust guest-profile merge for when an unregistered passenger (whose profile
-- was created by dispatch via signInAnonymously) later signs up via OTP.
--
-- The naive approach of UPDATE profiles SET id = newId fails with a FK violation
-- when rides.passenger_id references the old guest id. This function updates all
-- FK references first, then deletes the old profile and inserts the real one.

CREATE OR REPLACE FUNCTION merge_guest_profile(
  p_old_id  uuid,
  p_new_id  uuid,
  p_new_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guest profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_guest FROM profiles WHERE id = p_old_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Re-point all FK references before touching the PK
  UPDATE rides        SET passenger_id = p_new_id WHERE passenger_id = p_old_id;
  UPDATE ride_reviews SET passenger_id = p_new_id WHERE passenger_id = p_old_id;

  -- Delete the anonymous guest profile, then upsert the real one
  DELETE FROM profiles WHERE id = p_old_id;
  INSERT INTO profiles (id, phone, name, role)
    VALUES (
      p_new_id,
      v_guest.phone,
      COALESCE(NULLIF(trim(p_new_name), ''), v_guest.name),
      'passenger'
    )
  ON CONFLICT (id) DO UPDATE
    SET phone = EXCLUDED.phone,
        name  = EXCLUDED.name;
END;
$$;

GRANT EXECUTE ON FUNCTION merge_guest_profile(uuid, uuid, text) TO authenticated;
