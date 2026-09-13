-- Realtime cost: settle the publication question, then re-measure
-- Written 2026-09-12, after the RLS InitPlan fix (20260772) landed.
--
-- Goal: decide whether the Broadcast migration is the next piece of work, or
-- whether it waits for more drivers. The 89.2s `realtime.list_changes` figure
-- in db-load-free-tier-exhaustion.md was measured across three walks, BEFORE
-- the dashboard polling cuts and BEFORE HEARTBEAT_MS went 10s -> 20s. So a
-- naive re-read is not comparable to it.
--
-- Run the sections in order. Section 0 may reorder the whole conclusion, so
-- do not skip ahead to the reset.

-- ===========================================================================
-- SECTION 0 — BLOCKING. What is actually being decoded off the WAL?
-- ===========================================================================
-- This has been the "first query to run" in the db-load note since 2026-09-10
-- and is still unanswered. Since then we shipped background tracking, which
-- batch-INSERTs into `driver_locations` every ~60s per driver (FLUSH_AGE_MS).
-- If that table is in the publication we have added a fresh decode-and-fanout
-- stream that NOTHING subscribes to -- and removing it is one ALTER, not a
-- client migration.

select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by 1;

-- Read it like this:
--   driver_locations present  -> drop it first (below), re-measure, THEN judge
--                                Broadcast. Zero client work, zero risk: the
--                                app only INSERTs, nothing listens.
--   drivers present           -> expected; this is the O(drivers x dashboards)
--                                heartbeat fanout the Broadcast work targets.
--   rides / ride_messages     -> expected and wanted; real subscribers.

-- Only if driver_locations turned up above. Reversible with ADD TABLE.
-- alter publication supabase_realtime drop table public.driver_locations;

-- ===========================================================================
-- SECTION 1 — SNAPSHOT BEFORE RESET. Destructive step follows; there is no
-- way to reconstruct this afterwards.
-- ===========================================================================
select
  round((total_exec_time / 1000)::numeric, 1) as total_sec,
  calls,
  round(mean_exec_time::numeric, 1)           as mean_ms,
  round((100 * total_exec_time
         / sum(total_exec_time) over ())::numeric, 1) as pct,
  left(query, 120)                            as query
from pg_stat_statements
order by total_exec_time desc
limit 20;

-- Also record the window this covers, so the "after" can be rate-normalised:
select stats_reset from pg_stat_statements_info;

-- Paste both results into this file under "BASELINE" before continuing.

-- ===========================================================================
-- SECTION 2 — RESET
-- ===========================================================================
select pg_stat_statements_reset();

-- ===========================================================================
-- SECTION 3 — THE MEASUREMENT HOUR. Specify it or it answers nothing.
-- ===========================================================================
-- `realtime.list_changes` is driven by WRITES to published tables, which means
-- driver heartbeats -- not by dashboard tabs. An hour with a dashboard open and
-- no driver phone online reads near-zero and "proves" Broadcast is unnecessary,
-- for entirely the wrong reason.
--
-- The hour must contain, and you must write down:
--   * N driver phones online, for M minutes each   (M is the number that
--     normalises against the three-walk baseline -- record it)
--   * K dispatch dashboard tabs open, for how long
--   * Studio CLOSED. Its introspection queries were 11-16s each and it polls
--     them; leaving it open makes the monitoring a real slice of the load.
--
-- Factor out before attributing anything: HEARTBEAT_MS is now 20s, not 10s,
-- so per-driver write rate already halved independent of any realtime change.
-- Halve the baseline's realtime figure before comparing, or credit goes to the
-- wrong fix.

-- ===========================================================================
-- SECTION 4 — RE-READ, after the hour
-- ===========================================================================
-- Same query as Section 1.
select
  round((total_exec_time / 1000)::numeric, 1) as total_sec,
  calls,
  round(mean_exec_time::numeric, 1)           as mean_ms,
  round((100 * total_exec_time
         / sum(total_exec_time) over ())::numeric, 1) as pct,
  left(query, 120)                            as query
from pg_stat_statements
order by total_exec_time desc
limit 20;

-- Decision rule, set in advance so the number cannot be rationalised:
--   realtime still >40% of total  -> Broadcast migration is the next work.
--   realtime <20%                 -> it waits for more drivers; take the next
--                                    item off the ranking instead.
--   in between                    -> extrapolate: the cost is linear in
--                                    (drivers x dashboards), so multiply by the
--                                    fleet size you are pitching, not the one
--                                    you have.

-- ===========================================================================
-- BASELINE (paste results here)
-- ===========================================================================
-- Section 0:
-- Section 1:
-- stats_reset:
-- hour composition (N drivers x M mins, K tabs):
-- Section 4:
