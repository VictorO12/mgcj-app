-- "passengers can view active drivers" had no role restriction, so admins
-- were also seeing all active drivers across companies via this policy.
-- Admins get their company's drivers through "admins can read all drivers";
-- this policy should only apply to passengers and drivers.

DROP POLICY IF EXISTS "passengers can view active drivers" ON drivers;
CREATE POLICY "passengers can view active drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (is_active = true AND get_my_role() <> 'admin');
