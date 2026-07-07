-- Allow admins to update vehicle info for drivers in their company.
-- Previously only SELECT was granted to admins on the drivers table.

CREATE POLICY "admins can update drivers in their company"
  ON drivers FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  )
  WITH CHECK (
    get_my_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = drivers.id
        AND profiles.company_id = get_my_company_id()
    )
  );
