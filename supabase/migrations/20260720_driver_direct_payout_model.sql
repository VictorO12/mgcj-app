-- Schema for the second payout model: driver_direct. Card fares route
-- straight to a driver's own Stripe Connect Express account instead of the
-- company's; cash fares still get invoiced to the company, cash-portion only.
-- See memory: project_driver_direct_payout_model. Nothing routes on this yet
-- — create-payment-intent / capture-payment still only know company_settles
-- until that follow-up change lands.

-- ── companies.payout_model ──────────────────────────────────────────
-- Per-company, not platform-wide — M&G/C&J's own model isn't decided yet,
-- and other prospects (Casino Taxi-style) may want driver_direct from day
-- one. Defaults to company_settles so every existing company keeps today's
-- behavior with no backfill needed.
alter table companies
  add column if not exists payout_model text not null default 'company_settles'
    check (payout_model in ('company_settles', 'driver_direct'));

-- ── drivers Connect account fields ──────────────────────────────────
-- Onboarding is optional per-driver even under a driver_direct company —
-- a driver who never completes it just keeps routing through the company's
-- account, same as company_settles. stripe_connect_account_id is the
-- source of truth for "has an account object been created"; connect_status
-- tracks whether that account can actually receive transfers yet, mirroring
-- the companies.stripe_onboarded / stripe_account_id split already in use
-- (capture-payment gates on stripe_onboarded, not just account id presence,
-- for the same reason — see 20260719 migration and capture-payment/index.ts).
alter table drivers
  add column if not exists stripe_connect_account_id text,
  add column if not exists connect_status text not null default 'not_started'
    check (connect_status in ('not_started', 'pending', 'complete'));
