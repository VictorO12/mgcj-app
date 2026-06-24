-- Lock down the discount feature's tables with RLS. Previously these had
-- table-level grants to `authenticated` with no row-level scoping, meaning
-- any signed-in user could read or write another company's discount codes
-- or sponsored-institution list directly via the client. Edge functions
-- already use the service role key (which bypasses RLS), so none of this
-- affects the booking flow — only direct client access from the dashboard
-- and mobile app.

-- institutions: read-only platform catalog, fine for any authenticated user
-- to see (no company-sensitive data). Writes were never granted to
-- authenticated, so this just makes the existing intent explicit.
alter table institutions enable row level security;
create policy "institutions_select_all" on institutions
  for select using (true);

-- company_sponsored_institutions: dispatch can see and manage only their
-- own company's sponsorships.
alter table company_sponsored_institutions enable row level security;

create policy "csi_select_own_company" on company_sponsored_institutions
  for select using (company_id = get_my_company_id());

create policy "csi_admin_insert" on company_sponsored_institutions
  for insert with check (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

create policy "csi_admin_update" on company_sponsored_institutions
  for update using (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  ) with check (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

create policy "csi_admin_delete" on company_sponsored_institutions
  for delete using (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

-- discount_codes: dispatch can see and manage only their own company's
-- codes. Passengers never need direct table access — code validation at
-- booking time goes through compute_discount_for_booking(), which is
-- SECURITY DEFINER and bypasses RLS the same way get_my_role()/
-- get_my_company_id() already do.
alter table discount_codes enable row level security;

create policy "dc_select_own_company" on discount_codes
  for select using (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

create policy "dc_admin_insert" on discount_codes
  for insert with check (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

create policy "dc_admin_update" on discount_codes
  for update using (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  ) with check (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

create policy "dc_admin_delete" on discount_codes
  for delete using (
    company_id = get_my_company_id() and get_my_role() = 'admin'
  );

-- student_verification_tokens: contains emails + one-time tokens. Only the
-- two edge functions touch this table, and both use the service role key —
-- the `authenticated` grant was never actually needed by the client, so
-- revoke it and leave RLS enabled with zero policies (deny-all for
-- anon/authenticated; service_role bypasses RLS as usual).
revoke select, insert, update on student_verification_tokens from authenticated;
alter table student_verification_tokens enable row level security;
