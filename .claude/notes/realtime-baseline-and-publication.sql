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
-- BASELINE — captured 2026-09-13 00:39 UTC. NOT the measurement that was
-- planned, and better than it: this window turned out to be a clean IDLE
-- baseline, which the plan above never thought to take.
--
-- Section 0: driver_locations NOT in supabase_realtime. Published tables are
--   profiles, drivers, rides, ride_reviews, companies, messages,
--   driver_chat_messages, dispatch_events, ride_receipts.
--
-- Window: 93.0 min (stats_reset 2026-09-12 23:06:10 UTC).
-- Load during it: ZERO. No driver online (0 of 5 non-demo), no app running,
--   no dashboard tab, no Studio. Only pg_cron and pg_net.
--
--   total_sec  calls   mean_ms   pct   what
--   70.2       10474   6.7       81.2  realtime.list_changes
--    4.4         710   6.1        5.0  pgrst RPC on p_profile_ids
--    3.3         355   9.4        3.9  rides select (dashboard fetchRides)
--    1.8         355   5.0        2.1  drivers select
--    1.4         383   3.6        1.6  net._http_response cleanup delete
--    1.1/0.9    133/106            2.4 net.http_post (cron -> edge functions)
--    0.2         355   0.6        0.2  driver_reports badge count
--
-- Three readings, in order of how much they change the plan:
--
-- 1. THE BROADCAST MIGRATION WOULD NOT HAVE FIXED THIS. It targets the WAL
--    payload produced by driver heartbeats. There were no drivers online and
--    the cost is still 81% of everything. That alone is fatal to it, and the
--    conclusion rests on nothing else.
--
--    10474 calls / 5580 s = 1.88/s, i.e. a fixed timer -- the exact cadence is
--    NOT verified and should not be quoted; several intervals fit that rate.
--    The useful HYPOTHESIS (not an established fact -- one data point at zero
--    load cannot establish it) is that call count is time-driven while writes
--    move mean_ms. 5c tests it. If calls DO rise under load, the floor-vs-
--    payload split below needs rework.
--
--    Either way: do not start Broadcast on the strength of the 89.2s figure.
--
-- 2. The RLS fix held. `rides` mean is 9.4ms against 43.3ms before, and the
--    driver_reports badge count that started the whole investigation is now
--    0.2s total. pgbouncer.get_auth (39.7s during the crisis) does not appear
--    at all -- that was the throttle cascade, and it is over.
--
-- 3. In absolute terms the database is idle and healthy. All queries summed
--    are ~86.5s of CPU across 5580s of wall clock = ~1.55% of one core, of
--    which realtime's idle poll is ~1.26%. That is not what exhausts CPU
--    credits. The crisis is not ongoing.
--
-- What 6.7ms per idle poll means: it should be near zero with no WAL to walk.
-- It isn't, so something IS generating WAL with the app shut -- pg_cron
-- (job_run_details), pg_net (_http_response inserts plus that cleanup DELETE
-- at 4/min), and the cron-driven edge function posts. Logical decoding must
-- walk ALL WAL records and discard the unpublished ones, so those internal
-- tables cost realtime work despite not being published. Unverified; see the
-- WAL-rate check in the next section.
--
-- ON THE DECISION RULE WRITTEN ABOVE: it said "realtime >40% of total ->
-- Broadcast is the next work". It returned 81.2% and the answer is still don't
-- build it. The rule did not fail -- its PREMISE did: it assumed the window
-- contained load, and this one contained none, so a share of ~nothing carries
-- no information. Keep the lesson, not the threshold: a rule stated as a share
-- is meaningless without also stating the denominator it assumes.
--
-- OPTIONAL, NOT BLOCKING: the loaded window. At ~1.55% of one core the database
-- is not a problem at current size, so the per-driver slope answers a SCALING
-- question ("does this bite at 300 drivers?"), not a fix-it-now one. Take it
-- opportunistically -- the next time a driver phone is online for a stretch,
-- which happens by itself once there is a store build. Do not hold the store
-- build for it. See SECTION 5.

-- ===========================================================================
-- SECTION 5 — the loaded window, and the WAL question
-- ===========================================================================

-- 5a. RUN THIS FIRST. It can reframe everything else: MULTIPLE slots, or any
--     slot with active = false, means an inactive logical slot is pinning WAL
--     -- which makes every later decode walk more of it, and is a different
--     problem from an idle poll cost with a different fix.
select slot_name, plugin, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn))
         as behind
from pg_replication_slots;

-- 5b. Then: is the idle floor really pg_cron/pg_net WAL? Run twice, 60s apart,
--     with nothing open; the diff is bytes of WAL generated per minute by
--     internals alone. A large number means the cheaper lever is pruning
--     cron/pg_net write volume, not migrating client subscriptions.
select pg_current_wal_lsn(), now();

-- 5c. The loaded window. Reset, then run 30-60 min with a KNOWN load:
--       1 driver phone online (record minutes, and moving vs parked)
--       1 dashboard tab open (record minutes)
--       Studio closed
--     Then re-run the Section 1 ranking and compare against the idle baseline:
--
--       mean_ms delta on realtime.list_changes  -> payload cost per driver
--       calls   delta                           -> should be ~zero (time-driven)
--
--     Extrapolate the mean_ms delta linearly in (drivers x dashboards). If one
--     driver moves the mean by a fraction of a millisecond, Broadcast waits a
--     long time. If it moves it by milliseconds, it is a real ceiling and the
--     fleet size where it bites is now computable rather than guessed.

-- BASELINE (paste results here)
-- superseded — results are recorded inline above.
