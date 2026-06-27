-- Passengers were seeing active drivers from all companies.
-- Scope the policy so passengers only see active drivers from their own company.
-- Reuses the existing SECURITY DEFINER function to avoid RLS recursion.

DROP POLICY IF EXISTS "passengers can view active drivers" ON drivers;
CREATE POLICY "passengers can view active drivers"
  ON drivers FOR SELECT
  TO authenticated
  USING (
    is_active = true
    AND get_my_role() <> 'admin'
    AND admin_driver_in_my_company(drivers.id)
  );
