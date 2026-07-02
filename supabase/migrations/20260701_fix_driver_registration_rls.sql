-- Fix driver registration: the "anyone can mark invite as used" UPDATE policy
-- kept hitting 42501 because the "admins can manage invites" FOR ALL policy's
-- WITH CHECK interferes even for drivers.  Replacing the direct UPDATE with a
-- SECURITY DEFINER function sidesteps all permissive-policy interaction and is
-- the simplest reliable fix.

DROP POLICY IF EXISTS "anyone can mark invite as used" ON driver_invites;
CREATE POLICY "anyone can mark invite as used"
  ON driver_invites FOR UPDATE
  TO authenticated
  USING (used = false)
  WITH CHECK (used = true);

-- SECURITY DEFINER wrapper so the client-side RPC bypasses RLS entirely.
-- The WHERE used = false guard means it's a no-op if the invite is already used.
CREATE OR REPLACE FUNCTION mark_invite_used(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE driver_invites
  SET used = true
  WHERE id = p_invite_id AND used = false;
$$;

GRANT EXECUTE ON FUNCTION mark_invite_used(uuid) TO authenticated;
