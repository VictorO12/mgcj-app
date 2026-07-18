-- Billing contact info for cash-invoice delivery (Vellon Ops PDF invoicing).
-- Free text, matching the existing hst_number convention — no structured
-- address modeling. Both nullable: filled in at onboarding if available, or
-- later via the vellon-ops Companies page.

alter table companies
  add column if not exists billing_email   text,
  add column if not exists billing_address text;
