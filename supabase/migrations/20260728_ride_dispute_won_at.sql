-- Winning a dispute makes a ride payable again — but nothing noticed.
--
-- THE BUG (demonstrated live in sandbox 2026-07-21, ride 37ad297e / dispute
-- du_1TvT1p0..., $22.09 stranded)
-- A ride disputed while its payout was still held (settlement_route
-- 'platform_invoiced' or 'transfer_failed') becomes permanently unpayable once
-- Vellon WINS the dispute, even though winning returns the fare and the driver
-- is genuinely owed their share. Two independent blockers:
--
--   1. sweep-held-transfers filtered `stripe_dispute_id IS NULL`. That id is
--      never cleared, so the ride was excluded from the sweep forever.
--   2. Even without (1), the sweep's live guard skipped any charge with
--      `charge.disputed` — and that flag stays TRUE on Stripe's charge object
--      permanently, including after a win. Verified against ch_3TvT1E...:
--      status succeeded, disputed true, refunded false, long after 'won'.
--
-- Meanwhile stripe-webhook's charge.dispute.closed won-handler only re-sends a
-- transfer when settlement_route = 'transfer_reversed' (undoing its own
-- reversal). A ride that never had a transfer sent doesn't match, so it logged
-- "nothing to re-send" and moved on. Neither component was wrong on its own —
-- the gap was between them: nothing handled "won a dispute on a ride whose
-- payout had not yet gone out".
--
-- THE FIX
-- Stamp the win here, and let sweep-held-transfers pay it with the guards it
-- already has (live capabilities.transfers check, transfer_group dedup against
-- Stripe, hour-bucketed idempotency, destination re-resolution) rather than
-- duplicating all of that in the webhook.
--
-- WHY A MARKER COLUMN AND NOT JUST DROPPING THE SWEEP'S DISPUTE FILTER
-- Letting the live Stripe check do all the gating would need no schema change,
-- but it starves the sweep: its query is `order(completed_at asc).limit(50)`,
-- and rides with LOST disputes are old and never become payable, so they would
-- permanently occupy the front of the queue. Once 50 accumulated, they would
-- crowd out every legitimately payable ride and the sweep would silently stop
-- paying anyone. This column keeps lost/open disputes out of the query
-- entirely.
--
-- `stripe_dispute_id` is deliberately NOT cleared on a win — that would destroy
-- the audit trail and break vellon-ops' dispute_costs → ride join.
--
-- Set only by stripe-webhook (service role). No new grants needed: rides is
-- already exposed via the Data API.

alter table rides
  add column if not exists dispute_won_at timestamptz null;

comment on column rides.dispute_won_at is
  'Set when a dispute on this ride closed as won. Re-admits held payouts (platform_invoiced/transfer_failed) to sweep-held-transfers, which still live-verifies every dispute on the charge is won before sending. Never cleared; stripe_dispute_id is kept alongside it for audit.';

-- Partial index: the sweep's hot path is "held payouts that are either
-- undisputed or dispute-won". Tiny by construction — only won disputes.
create index if not exists rides_dispute_won_at_idx
  on rides (dispute_won_at)
  where dispute_won_at is not null;

-- ── Backfill ────────────────────────────────────────────────────────────
-- Ride 37ad297e's dispute closed as won BEFORE this column existed, so its
-- webhook fired with nowhere to record the win. Backfilled from the observed
-- Stripe state rather than left stranded. Scoped by id so it can't touch
-- anything else; safe to re-run (idempotent via the null guard).
update rides
   set dispute_won_at = now()
 where id = '37ad297e-6397-4fb5-978f-9f79dcc6fd5d'
   and stripe_dispute_id = 'du_1TvT1p0PM9oQnFTE95izndZU'
   and dispute_won_at is null;
