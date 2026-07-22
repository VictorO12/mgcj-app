-- Voluntary (non-dispute) refund support.
--
-- Refunds are issued by Vellon (the platform owner) from vellon-ops after
-- investigating a passenger complaint — there is no self-serve refund button
-- anywhere in the app/dashboard. A refund pulls the fare back off Vellon's
-- Stripe balance, but the driver/company transfer that already went out is NOT
-- automatically clawed back, so without this Vellon silently eats the driver's
-- share. The stripe-webhook `charge.refunded` handler now reverses the matching
-- slice of that transfer, driven by the refund's REASON:
--
--   driver_fault     -> "driver_company" absorbs: claw the refund back from the
--                       transfer, DRIVER-FIRST (recover up to the driver/company's
--                       whole share before Vellon supplements any overflow).
--   platform_mistake -> "vellon" absorbs: no clawback, Vellon eats it.
--   goodwill         -> "vellon" absorbs: no clawback, Vellon eats it.
--   (passenger fraud -> not a refund at all; the operator just declines.)
--
-- The reason/absorbed_by decision rides to the webhook as Stripe REFUND METADATA
-- (metadata[reason], metadata[absorbed_by]) so the reversal logic never has to
-- race a DB write. These columns mirror it on the ride for display/reporting and
-- as a fallback; they are also written for refunds issued straight in the Stripe
-- dashboard (out-of-band), where the webhook reads the metadata (absent) as null
-- and defaults to the driver-first clawback.
--
-- Cents everywhere (matching transfer_amount_cents) except fare_final, which is
-- dollars — the reversal math is done in cents against transfer_amount_cents and
-- the transfer's own amount_reversed (read live from Stripe as the idempotency
-- source of truth).

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS refunded_amount_cents  integer,      -- cumulative refunded to the passenger
  ADD COLUMN IF NOT EXISTS transfer_reversed_cents integer,     -- cumulative clawed back from the transfer
  ADD COLUMN IF NOT EXISTS refunded_at            timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_refund_id       text,         -- most recent refund id
  ADD COLUMN IF NOT EXISTS refund_reason          text,         -- 'driver_fault' | 'platform_mistake' | 'goodwill'
  ADD COLUMN IF NOT EXISTS refund_absorbed_by     text;         -- 'driver_company' | 'vellon'

-- New settlement_route value documented (no enum — settlement_route is free text):
--   'refund_reversed' — a driver_fault refund's clawback succeeded; the driver/
--                       company keeps only their un-refunded share. A clean final
--                       state: NOT actionable, NOT swept by sweep-held-transfers,
--                       and NOT re-paid by the dispute.closed(won) handler (which
--                       only re-transfers 'transfer_reversed'). A FAILED clawback
--                       reuses the existing actionable 'reversal_failed' route
--                       (same remediation: collect the over-paid share back).
--
-- A "vellon" (platform_mistake/goodwill) refund leaves settlement_route UNCHANGED
-- (the driver correctly keeps their money) — the refund is recorded only via the
-- columns above, and reported by refund_absorbed_by = 'vellon'.
--
--   'refund_review'  — an OUT-OF-BAND refund (issued straight in the Stripe
--                       dashboard, no reason metadata) on a ride with an
--                       outstanding transfer. The webhook won't guess a driver's
--                       fault, so it flags rather than claws back; surfaces in
--                       vellon-ops's stranded-settlements list for manual
--                       reconciliation. Actionable, Vellon-side (NOT dispatch).

-- No GRANTs needed: adding columns to an already-exposed table. rides is written
-- here only by the service role (webhook + vellon-ops connector), never the
-- Data API from an end-user JWT.
