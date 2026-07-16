-- Let dispatchers SELECT their company's discount codes.
--
-- The discount_codes RLS (20260625_discount_rls.sql) predates the dispatcher
-- role split (20260715_dispatcher_role_split.sql). Back then "dispatch" WAS
-- admin, so dc_select_own_company was gated on get_my_role() = 'admin'. After
-- the split, dispatchers do day-to-day ride ops — which includes creating rides
-- and applying discount codes — but the dashboard's booking picker reads
-- discount_codes directly, so RLS returned an empty list for dispatchers and
-- they saw no codes. (The code math itself still worked: submit-time validation
-- goes through compute_discount_for_booking(), a SECURITY DEFINER that bypasses
-- RLS — only the picker list was affected.)
--
-- Widen SELECT to is_staff() (admin OR dispatcher), matching how the role-split
-- migration widened other ride-ops reads. Managing codes (insert/update/delete)
-- stays admin-only config — those policies are untouched.

DROP POLICY IF EXISTS "dc_select_own_company" ON discount_codes;
CREATE POLICY "dc_select_own_company" ON discount_codes
  FOR SELECT USING (
    company_id = get_my_company_id() AND is_staff()
  );
