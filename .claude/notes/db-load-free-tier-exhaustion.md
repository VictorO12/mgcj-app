# Free-tier CPU exhaustion, 2026-09-10 — what it was and what to do about it

Supabase became unresponsive mid-session: compute ~70%, auth/storage reporting
unhealthy, SQL editor unable to run. Victor's read was "one device is doing
this". It wasn't one device, and it also wasn't really the query volume.

## Two separate things, and the order matters

**1. The instance had no CPU left.** The tell is not the request count, it is
the durations:

```
pgbouncer.get_auth        39,676 ms
realtime.list_changes     25,637 ms
pg_stat_statements agg    16,236 ms
```

Connection-pool *authentication* taking 39 seconds is not what ~1-2 req/s does
to a healthy Postgres. Free tier runs on a CPU-credit budget; once the balance
is spent you are throttled to a fraction of baseline and everything cascades —
statement timeouts, `POST /auth/v1/token` 504s, stuck `ShareLock` waits.

So the query pattern below *drained* the credits over hours. It is not a load
the database is structurally unable to serve. **Fix the throttle first
(shed load, wait), then fix the drain** — optimising queries while still
throttled looks like it did nothing.

**2. What drained it**, per open dashboard tab:

| source | rate | notes |
|---|---|---|
| `fetchAll` — 9 fetchers, ~15 HTTP requests | every 15s | incl. `rides select=* limit 150`, `drivers select=*` |
| active-ride status poll | every **2s** | 30 req/min, more than the whole 15s loop |
| driver app heartbeat `PATCH /drivers` | every 10s | per driver |

Plus Supabase Studio itself, whose introspection queries were 11-16s each and
which polls them — the monitoring was a real slice of the load being monitored.

## Load-shedding checklist (no DB access required)

1. Force-quit the driver app — stops the 10s PATCH.
2. Close the Studio tab.
3. Close the dispatch dashboard.
4. Wait 15-30 min. A restart does NOT refill credits, but does clear stuck
   locks and runaway queries if the backlog is self-sustaining.

pg_cron keeps running throughout and cannot be stopped without SQL, so it never
goes fully quiet.

## Applied 2026-09-10

- **Dashboard**: `fetchAll` split into dynamic vs `fetchStaticConfig`
  (`driver_invites`, `discount_codes`, `vehicle_classes`, `companies` — moved
  from every 15s to every 5 min). ~5 of ~15 requests per cycle removed.
- **Dashboard**: active-ride poll 2s -> 5s.
- **App**: `HEARTBEAT_MS` 10s -> 20s. Still 3 beats inside
  `PRESENCE_STALE_MS` (60s), so the blip tolerance is unchanged in kind.

Rough effect per tab: ~90 req/min -> ~54. Real, not dramatic. The structural
item below is the one that matters.

## NOT done — the actual scaling problem

```js
{ event: "*", schema: "public", table: "drivers" }   // DashboardPage.tsx
```

The dashboard subscribes to every change on `drivers`, and the app writes
`drivers` every heartbeat for liveness. So each beat is a row write, a WAL
record, a realtime decode, and a broadcast of the **whole row** to every open
dispatch tab.

That is **O(drivers x dashboards)**. Eleven drivers and one tab is nothing;
300 drivers (Casino Taxi scale) is 30 writes/sec fanned out to every dispatcher
with the board open — and `list_changes` is *already* taking 12-25s at the
current size, which is that pipeline visibly struggling.

A 10-second liveness beat does not belong in a replicated table. Two directions,
both leaving `drivers` as the slow-changing roster it actually is:

- Realtime **Presence** — ephemeral, never touches Postgres.
- Split the hot columns (`last_seen_at`, `current_lat/lng`) into a table that is
  NOT in the publication, and let the dashboard read them on its own cadence.

Note the client-side subscription is only the *fanout*. WAL decode happens
because the table is in the publication, subscribers or not — so unsubscribing
in the dashboard does not remove the decode cost.

## First queries once SQL works again

```sql
-- Is driver_locations replicated? 8s inserts x drivers, decoded for nobody.
select tablename from pg_publication_tables where pubname = 'supabase_realtime';

-- The 2026-07-12 bloat fix: no record it was ever applied.
select jobname, schedule, active from cron.job;
select count(*) from cron.job_run_details;
select count(*) from net._http_response;
```

`cron.job_run_details` and `net._http_response` gain a row per cron run and per
async HTTP call, `scheduled-release` fires every 2 min, and nothing prunes them
unless `cleanup-cron-logs` actually got scheduled.

## On Pro

Pro removes the credit cliff by giving dedicated compute. It does not make any
of the above better. Buy it as demo-day insurance, not as a fix — the `drivers`
fanout needs solving on either tier.


## RLS per-row helper evaluation — found and fixed 2026-09-11

With three walks of real load behind `pg_stat_statements`, the ranking was:

| total_sec | calls | mean_ms | what |
|---|---|---|---|
| 89.2 | 12874 | 6.9 | `realtime.list_changes` — WAL decode |
| 18.7 | 433 | 43.3 | `rides select=*` — dashboard `fetchRides` |
| 13.5 | 427 | 31.7 | `driver_reports.id where status=open` — a **badge count** |

A badge count on a **three-row table** costing 31.7ms is the thread worth
pulling. `EXPLAIN` as `postgres` said 0.082ms — the SQL editor bypasses RLS, so
that number was meaningless. Re-run as `authenticated`: **6.9ms**, with
`get_my_role()` in the per-row Filter.

**`get_my_role()` was VOLATILE** (`get_my_company_id()` was correctly STABLE).
VOLATILE means Postgres must re-evaluate per row and can never hoist. The
arithmetic closes it: 6.9ms / 3 rows = 2.3ms/row, x150 rows = 43ms predicted for
`fetchRides`, against 43.3ms observed.

### Two measurements that changed the plan

1. **`ALTER FUNCTION ... STABLE` alone did nothing** — 6.9ms -> 6.69ms, identical
   plan. The marking *permits* hoisting; it does not force it. Both the
   volatility fix and the `(select f())` wrapper are needed.
2. **The first wrapper test was on the wrong table.** `driver_reports` is
   dominated by a nested `profiles` subplan whose cost is `shares_ride_with(id)`
   — a per-row argument that cannot be hoisted — so wrapping helped ~2%. Testing
   the actual #2 cost instead: **11.084ms -> 4.582ms, 2.4x**, from wrapping ONE
   of five OR branches.

Lesson worth keeping: measure the query that is actually expensive, not the one
that is convenient to reason about. The cheap-looking table was cheap; its
policy was reaching into an expensive one.

### Result, measured after applying (2026-09-11)

```
before   11.084 ms   cost 723.37   helpers in the per-row Filter
after     3.057 ms   cost  42.50   8 InitPlans, loops=1, three never executed
```

**3.6x faster**, and the cost estimate fell 17x — which matters beyond this
query, because a planner working from an inflated cost makes bad join and index
choices elsewhere.

Row counts per role were identical before and after (admin 134 / driver 308 /
anon 0 with profiles still `permission denied`), which is the only evidence that
"semantically identical" was true rather than intended.

### Shipped

`20260772_rls_initplan_hoisting.sql` — 24 `ALTER POLICY` statements across
`rides`, `drivers`, `profiles`, `driver_reports`. Plus two volatility fixes run
by hand (`get_my_role`, `admin_driver_in_my_company` -> STABLE).

Functions taking the row (`driver_in_my_company(id)`,
`admin_driver_in_my_company(id)`, `shares_ride_with(id)`) are deliberately left
unwrapped — their result varies per row, so hoisting them would be wrong.

Checks: `.claude/notes/rls-initplan-postapply-checks.sql`. **Section 1 must be
run BEFORE applying** — it captures per-role visible-row counts, and there is no
way to reconstruct them afterwards. A count that grew is a leak; one that shrank
is a lockout.

### Still open

Realtime at 89.2s is still the #1 cost and is untouched by any of this. The
Broadcast migration (position off `postgres_changes`) remains the larger fix —
see the thread-B design in the session notes.
