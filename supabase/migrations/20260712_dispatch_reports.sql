-- Lets dispatch admins report problems (bugs, driver issues, billing, feature
-- requests) straight to Victor from the dashboard Settings page. Visibility is
-- company-wide (not per-admin) since all dispatch users are peers today --
-- see root CLAUDE.md notes on the deferred owner/dispatcher role split.

CREATE TABLE dispatch_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  admin_id uuid NOT NULL REFERENCES profiles(id),
  category text NOT NULL CHECK (category IN ('bug', 'driver_issue', 'billing', 'feature_request', 'other')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Grants for PostgREST access (tables created after Oct 30 2026 need explicit grants)
GRANT SELECT, INSERT ON dispatch_reports TO authenticated;

ALTER TABLE dispatch_reports ENABLE ROW LEVEL SECURITY;

-- Admins file reports for their own company.
CREATE POLICY "admins submit reports"
ON dispatch_reports FOR INSERT
TO authenticated
WITH CHECK (
  get_my_role() = 'admin'
  AND company_id = get_my_company_id()
  AND admin_id = auth.uid()
);

-- Any admin at the company can see all reports filed there (company-wide, not per-admin).
CREATE POLICY "admins read their company reports"
ON dispatch_reports FOR SELECT
TO authenticated
USING (
  get_my_role() = 'admin'
  AND company_id = get_my_company_id()
);
