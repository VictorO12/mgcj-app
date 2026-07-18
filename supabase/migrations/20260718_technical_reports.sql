-- Lets passengers and drivers report technical problems (bugs, payment
-- issues, account issues) straight to Vellon from the mobile app's Help &
-- Support screen. Companion to dispatch_reports (20260712), which covers the
-- admin/dispatcher-side report path from the dashboard.
--
-- Identity columns (reporter_id, reporter_role, company_id) are stamped
-- server-side by a trigger rather than trusted from the client insert, same
-- rationale as the fare-freeze/payment-method guards in root CLAUDE.md:
-- profiles is RLS-gated by row not by column, so a client-supplied
-- reporter_id/role could otherwise be spoofed to impersonate another user.

CREATE TABLE technical_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES profiles(id),
  reporter_role text NOT NULL CHECK (reporter_role IN ('passenger', 'driver')),
  company_id uuid REFERENCES companies(id),
  ride_id uuid REFERENCES rides(id),
  category text NOT NULL CHECK (category IN ('bug', 'payment', 'account', 'other')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Grants for PostgREST access (tables created after Oct 30 2026 need explicit grants)
GRANT SELECT, INSERT ON technical_reports TO authenticated;

CREATE OR REPLACE FUNCTION stamp_technical_report_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.reporter_id := auth.uid();
  NEW.reporter_role := get_my_role();
  NEW.company_id := get_my_company_id();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_technical_report_identity
BEFORE INSERT ON technical_reports
FOR EACH ROW
EXECUTE FUNCTION stamp_technical_report_identity();

ALTER TABLE technical_reports ENABLE ROW LEVEL SECURITY;

-- Passengers and drivers can file their own reports (identity columns are
-- overwritten server-side by the trigger above regardless of what's sent).
CREATE POLICY "passengers and drivers submit reports"
ON technical_reports FOR INSERT
TO authenticated
WITH CHECK (get_my_role() IN ('passenger', 'driver'));

-- A reporter can see their own past reports.
CREATE POLICY "reporters read their own reports"
ON technical_reports FOR SELECT
TO authenticated
USING (reporter_id = auth.uid());
