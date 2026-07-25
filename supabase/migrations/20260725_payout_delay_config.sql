-- Platform-wide payout-timing policy, read at Connect-account creation time.
--
-- Why a table (not a hardcoded constant): the payout delay used to be a literal
-- '7' in create-connect-account. Vellon needs to tune it without a redeploy —
-- and to run two different values for the two payout roles:
--   * driver_direct DRIVER accounts  -> driver_delay_days (kept low; the fare is
--     captured to the platform balance first, so a dispute lands on Vellon, not
--     the driver — the delay is only a manual refund/reversal cushion, not a
--     chargeback shield, so it doesn't need to be long).
--   * company_settles COMPANY accounts -> company_delay_days (Vellon wants these
--     as close to "no wait" as Stripe permits).
--
-- NOTE on the Stripe floor: Canadian accounts can't pay out with zero delay —
-- Stripe floors delay_days at the account's country default (~2-3 business days
-- for CA). These values are the TARGET; the code that applies them
-- (create-connect-account, and vellon-ops' push-to-existing action) falls back
-- to Stripe's own minimum if Stripe rejects a value as too low. So "0" here
-- would simply resolve to Stripe's floor, not an error.
--
-- Singleton, service-role-only (Edge Functions + the vellon-ops mgcj connector).
-- No client ever reads this, so RLS is deny-all with no anon/authenticated
-- grant — same locked-down model as vellon-ops' own platform_settings table.

create table if not exists public.payout_config (
  id                 int primary key default 1,
  driver_delay_days  int not null default 2,
  company_delay_days int not null default 2,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  constraint payout_config_singleton check (id = 1),
  constraint payout_config_driver_days_range  check (driver_delay_days  between 0 and 31),
  constraint payout_config_company_days_range check (company_delay_days between 0 and 31)
);

alter table public.payout_config enable row level security;
-- No policies -> anon/authenticated get nothing. service_role bypasses RLS.

insert into public.payout_config (id) values (1)
on conflict do nothing;

-- Explicit service_role grant (post-2026-10-30 tables aren't exposed by
-- default; we deliberately expose it to service_role only, never anon).
grant select, insert, update on public.payout_config to service_role;
