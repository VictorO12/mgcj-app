-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 attention panel — manual test harness
--
-- ⚠ These write to the LIVE database. Both writes are cosmetic (no money, no
-- pipeline, no push) and section 5 undoes everything, but pick a ride you know
-- is yours. Run one section at a time with the dashboard open.
--
-- The SQL editor has no JWT, so auth.role() is NULL and the guard triggers let
-- these through — which is why this works without the passenger app.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Pick a target ───────────────────────────────────────────────────────
-- Needs to be in the dashboard's 150 most recent rides or the realtime merge
-- has nothing to merge into and nothing will happen on screen.
SELECT id, status, pickup_address, created_at
FROM rides
WHERE company_id = (SELECT id FROM companies ORDER BY name LIMIT 1)
ORDER BY created_at DESC
LIMIT 15;

-- ── 2. Passenger flag → expect toast + panel AUTO-OPENS + red ⚑ ────────────
UPDATE rides
   SET passenger_flagged_at       = now(),
       passenger_flag_updated_at  = now(),
       passenger_flag_reasons     = ARRAY['not_in_car'],
       passenger_flag_note        = 'Test — I was never picked up',
       passenger_flag_resolved_at = NULL
 WHERE id = '<RIDE_ID>';

-- 2b. Accumulate a second reason → panel row detail grows, card badge becomes
--     "Passenger flagged 2 issues", toast says "(+1 more)".
UPDATE rides
   SET passenger_flag_reasons    = ARRAY['not_in_car','felt_unsafe'],
       passenger_flag_updated_at = now()
 WHERE id = '<RIDE_ID>';

-- ── 3. Assignment hold → expect count to rise, panel must NOT auto-open ────
-- Only renders while pending/offered, so use a ride in one of those states.
UPDATE rides
   SET assignment_hold_reason = 'no_drivers'
 WHERE id = '<PENDING_RIDE_ID>' AND status IN ('pending','offered');

-- ── 4. What to look for ────────────────────────────────────────────────────
--   • ⚑ N in the topbar turns red once an act_now item exists
--   • Clicking a panel row opens the ride's live panel AND frames the map
--     with its route (not just the panel — that was a bug I fixed)
--   • "Mark resolved" on the card clears it from the panel and the count
--   • Reports → Ride escalations lists it, unresolved then resolved
--   • Close the panel; the ⚑ count stays, reopening still works
--   • With nothing flagged: panel reads "Nothing needs attention."

-- ── 5. Clean up ────────────────────────────────────────────────────────────
UPDATE rides
   SET passenger_flagged_at        = NULL,
       passenger_flag_updated_at   = NULL,
       passenger_flag_reasons      = NULL,
       passenger_flag_note         = NULL,
       passenger_flag_resolved_at  = NULL
 WHERE id = '<RIDE_ID>';

UPDATE rides SET assignment_hold_reason = NULL WHERE id = '<PENDING_RIDE_ID>';
