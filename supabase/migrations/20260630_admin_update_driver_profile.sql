-- Allow dispatch admins to update account-status fields on driver profiles
-- within their own company. This is needed for deactivation/reactivation.
-- The SECURITY DEFINER trigger already handles the deferred-deactivation flip,
-- so it bypasses RLS fine without this policy; this covers the direct update path.

CREATE POLICY "admins can manage driver account status"
ON profiles FOR UPDATE
TO authenticated
USING (
  get_my_role() = 'admin'
  AND role = 'driver'
  AND company_id = get_my_company_id()
)
WITH CHECK (
  get_my_role() = 'admin'
  AND role = 'driver'
  AND company_id = get_my_company_id()
);
