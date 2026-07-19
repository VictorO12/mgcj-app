-- Tracks how a driver_direct card fare was actually settled at capture time,
-- for the future settlement-view/invoicing work. company_settles rides never
-- set this (destination is always the company, nothing to disambiguate).
--
-- 'driver_transfer'  — driver had a complete Connect account, transferred to them
-- 'company_transfer' — driver skipped/incomplete Connect, fell back to the company's account
-- 'platform_invoiced' — neither driver nor company had a usable Connect account;
--                        funds stayed on the platform balance, to be invoiced
--                        to the company like a cash fare (future work)
-- 'transfer_failed'   — capture succeeded but the follow-up Stripe Transfer call
--                        errored; funds are on the platform balance pending manual retry

alter table rides
  add column if not exists settlement_route text
    check (settlement_route in ('driver_transfer', 'company_transfer', 'platform_invoiced', 'transfer_failed')),
  add column if not exists stripe_transfer_id text;
