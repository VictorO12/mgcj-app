-- Persists the REAL Stripe processing fee (never estimated) captured at
-- settlement time, for the driver/dispatch settlement-breakdown view.
-- Vellon's own cut is NOT duplicated here -- it's always derivable from
-- fare_final * platform_fee_percent_at_completion / 100, so no separate
-- column for it. Null until a card ride is captured; stays null for cash
-- rides (no Stripe transaction to read a fee off).

alter table rides
  add column if not exists stripe_fee numeric(6,2) null;
