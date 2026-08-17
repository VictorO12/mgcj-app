# Phase 3 — dispatch attention panel

Planned 2026-08-16. Phases 1–2 are built and verified; this is the surface that
makes a passenger escalation impossible to miss. Nothing here is built yet.

## The governing constraint: what does NOT go in it

The driver-digest lesson applies directly — *"at thousands of rides/day the
board is never empty, so 'new work exists' carries no information."* If coverage
warnings, stale offers, driver reports and passenger flags all land in one flat
list, dispatch learns to ignore the panel, and the `not_in_car` flag dies inside
the surface built to surface it.

So the tiers are decided up front, not discovered later:

| Tier | Items | Behaviour |
|---|---|---|
| **Act now** | Unresolved passenger flags; rides where auto-assign gave up | Auto-opens the panel, persists until actioned |
| **Watch** | Coverage `at_risk`/`uncovered` inside 24h | Listed, never auto-opens |
| **Not here** | Open driver reports | Already has a nav badge + its own page |

## Two documented blind spots this closes

These are why the panel earns its space rather than being one feature's badge.

1. **`assign-ride` gives up silently.** CLAUDE.md: *"dispatch has no dedicated
   indicator for this state yet, they'd need to notice the ride still sitting
   `pending`/`offered`."* A ride nobody took is exactly a panel item.
2. **The coverage toast is transient.** A dispatcher who stepped away misses it
   entirely. The panel is the durable version.

## Stored vs derived — this shapes the archive

- Passenger flags are **stored** (`passenger_flag_resolved_at`) → they have
  history.
- Stuck-pending and coverage are **derived** from state → no history; the
  condition simply ends.

**Therefore the archive is flags-only** (`rides WHERE passenger_flag_resolved_at
IS NOT NULL`). Derived items are live-only and clear when the condition clears.
Recorded so a future session doesn't try to build history for something never
recorded. Persisting alert instances would mean a new table and a writer — not
worth it unless a customer asks for an audit trail.

### Verified constraint: the 150-ride window

`fetchRides()` is `.limit(150)` ordered by `created_at desc`
(`DashboardPage.tsx:1714`). A scheduled ride booked weeks out can fall outside
that window in a busy company, so **coverage alerts derived from the in-memory
array are silently incomplete**. Either the panel runs its own query for open
scheduled rides, or it bounds itself to <24h and says so. The 24h bound is
recommended anyway — see the pill conflict below.

## Panel mechanics

**Overlay, not a layout column.** A column mirroring `.db-panel` with a
`border-left` would resize `db-map-wrap`; the map div stays mounted (so the
documented unmount gotcha does not apply), but the live-ride
`map.fitBounds(bounds, 80)` framing near `DashboardPage.tsx:2120` was computed
at the old width and goes stale. An absolutely-positioned overlay reflows
nothing and matches "pops up" better.

- A **persistent count indicator** (topbar or nav) is always visible.
- The panel **auto-opens only for the Act-now tier.** Coverage churn popping a
  panel over the map mid-dispatch is the fastest way to get it permanently
  collapsed.
- Closable, per Victor. Closing hides the panel, not the underlying items.

## Two gotchas that only bite on stage

1. **Seeded demo drivers generate permanent `at_risk` noise.** They read
   `at_risk` rather than `covered` since coverage became dispatchability-aware
   (2026-08-15); the demo protocol is one real driver phone online. If coverage
   feeds the panel, every pitch demo opens with a panel full of warnings.
   Scope coverage tightly or plan the demo interaction.
2. **`coverageDisplay()` hardcodes "Healthy" for anything >24h out**
   (`DashboardPage.tsx:943`) regardless of real `coverage_status`. If the panel
   reads the true value, the panel and the pill disagree about the same ride on
   the same screen. Bounding panel coverage items to <24h sidesteps it; fixing
   the pill is the better answer and is already a known open item.

## Archive placement

`ReportsPage` is single-table and driver-centric — `driverFilter`, per-driver
counts, a PDF export titled "Driver Report", `HIGH_SEVERITY` keyed to driver
reason codes. None of that transfers to a ride escalation.

So: a **source-level tab** (Driver reports | Ride escalations) sharing the page
shell, **not** one merged list. Keep `onBadgeChange` separate per source — a
combined nav count can't distinguish three driver complaints from three
passengers stuck in the wrong car.

## The toast

Phase 2's flag toast reuses the coverage toast strip and its own comment says
the panel replaces it. Decision: **keep it, narrowed.** The toast is the
arrival notification (something happened *now*); the panel is the durable list
(these things are *outstanding*). They answer different questions. Once the
panel exists the toast can drop its `(+N more)` / multi-ride counting, since the
panel carries that.

## Open questions for Victor

1. Overlay vs layout column (recommendation: overlay).
2. Does "stuck pending — auto-assign gave up" belong in the first cut, or is
   this panel flags-only to start?
3. Should the panel auto-open, or only pulse the count indicator?

## Sequencing

Commit Phases 1–2 before starting. Both repos are carrying two phases of
verified-working work plus notes; building Phase 3 on top makes one
undifferentiated diff with no revert point.
