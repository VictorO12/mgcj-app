# Phase 3 — dispatch attention panel

**BUILT 2026-08-16** (mgcj-dashboard only, no backend change). Not yet live-tested.
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
| **Act now** | Unresolved passenger flags | Auto-opens the panel, persists until resolved |
| **Act now** | Auto-assign exhausted (`no_drivers` / `all_declined`) | Listed, count only — no auto-open |
| **Later** | More sources Victor has in mind | Revisit; the item model must not assume flags |
| **Not yet** | Coverage `at_risk`/`uncovered` | Deferred — revisit after this phase |
| **Not here** | Open driver reports | Already has a nav badge + its own page |

### Duplication with card surfaces is DELIBERATE (decided 2026-08-16, Victor)

Both Act-now items already appear on the ride card — passenger flags as the red
badge, auto-assign exhaustion as `AssignmentHold` ("No drivers online" / "Every
driver declined", `DashboardPage.tsx:887`, from `20260750_assignment_hold.sql`).
That was raised as an argument for *not* putting them in the panel, and
overruled on purpose: **a card badge only helps a dispatcher already looking at
that card.** The panel is the aggregate view — one place that answers "is
anything wrong right now" without scanning the Active list.

So a future session must not "de-duplicate" these. The two surfaces answer
different questions.

Note this also corrects a stale claim in the root CLAUDE.md, which still says
`assign-ride` gives up silently and *"dispatch has no dedicated indicator for
this state yet"*. `AssignmentHold` is that indicator; the note predates
`20260750`.

**Coverage is deferred, not rejected (2026-08-16, Victor).** It already has two
surfaces;
a third is duplication, and it was the single item dragging in every
complication in this plan: the pill/panel disagreement below, the 150-ride
window, and the seeded-demo-driver noise. All three evaporate without it. The
panel is for things with *no* surface — which leaves a tight first cut where
every item means "act now".

Revisit after this phase and see what needs reworking — including
`coverageDisplay()`'s >24h hardcode (see below), where a structural gap booked
weeks ahead currently displays as "Healthy". Fixing the pill may turn out to be
the whole answer.

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

### Moot while coverage is out — the 150-ride window

`fetchRides()` is `.limit(150)` ordered by `created_at desc`
(`DashboardPage.tsx:1714`). A scheduled ride booked weeks out can fall outside
that window in a busy company, so **coverage alerts derived from the in-memory
array are silently incomplete**. Either the panel runs its own query for open
scheduled rides, or it bounds itself to <24h and says so. The 24h bound is
recommended anyway — see the pill conflict below.

## The item model — build this typed, not flag-shaped

Victor wants further sources in the panel beyond the two below ("some other
thing I'd want put in which we'll revisit"). So the first cut must NOT hardcode
passenger flags into the rendering; adding a source later should be one entry in
a list, not a refactor.

```
type AlertItem = {
  key:    string                      // stable across re-renders
  tier:   'act_now' | 'watch'
  source: 'passenger_flag' | 'assignment_hold' | ...
  rideId: string
  title:  string                      // "Passenger says they're NOT in the car"
  detail?: string                     // note text, reason list
  at:     string                      // for ordering — newest first within tier
}
```

Each source is a pure function from the rides already in memory (plus, later,
its own query) to `AlertItem[]`; the panel concatenates, sorts by tier then
`at`, and renders one row component. Clicking a row opens that ride — the panel
is a way *into* the board, never a place to action things in isolation.

`passenger_flag` is **stored** (`passenger_flagged_at` / `_resolved_at`) so it
has history. `assignment_hold` is **derived** from `assignment_hold_reason` on a
`pending`/`offered` ride, so it clears itself when the ride gets a driver or
`expire-pending-rides` cancels it at the 5-minute mark — no dismissal state
needed, and no history.

## Panel mechanics

**Overlay, not a layout column** (confirmed 2026-08-16). A column mirroring `.db-panel` with a
`border-left` would resize `db-map-wrap`; the map div stays mounted (so the
documented unmount gotcha does not apply), but the live-ride
`map.fitBounds(bounds, 80)` framing near `DashboardPage.tsx:2120` was computed
at the old width and goes stale. An absolutely-positioned overlay reflows
nothing and matches "pops up" better.

- A **persistent count indicator** (topbar or nav) is always visible.
- The panel **auto-opens only for a new passenger flag** (confirmed
  2026-08-16). Not for assignment holds: a company with nobody on shift would
  have the panel open over the map permanently, which is the fastest way to get
  it collapsed for good. Everything else just moves the count.
- Closable, per Victor. Closing hides the panel, not the underlying items.

## Two gotchas — both coverage-only, so both moot in the first cut

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

All four resolved 2026-08-16:

1. **Overlay**, not a layout column.
2. **Stuck-pending is in**, despite already having a card surface — the panel is
   the aggregate view (see "Duplication is deliberate" above).
3. **Auto-open for passenger flags only**; everything else pulses the count.
4. **Coverage deferred** to after this phase, then reassess what needs reworking.

Still open: what the additional sources are. The item model above is built so
they cost one function each.

## What shipped

- `buildAlerts()` + the `AlertItem` model in `DashboardPage.tsx` — two sources
  (`passenger_flag`, `assignment_hold`), each a pure function from rides in
  memory. Adding a source is an entry here, not a rendering change.
- `.db-alerts` overlay inside `db-map-wrap`, right-anchored at `right:16px`
  (`db-ride-float` is `left:16px`, so they never collide). Nothing reflows.
- Topbar `⚑ N` button, always present so "nothing needs me" is a readable state
  rather than an absence; turns red only when an `act_now` item exists.
  Toggles the panel.
- Auto-open on a NEW passenger flag only, in the same realtime branch as the
  toast. Assignment holds move the count.
- `ReportsPage` gains a **source switcher** (Driver reports | Ride escalations)
  with separate counts — a combined nav badge could not distinguish driver
  complaints from passengers stuck in the wrong car. The escalations list is
  flags-only (stored); derived alerts have no history to archive.
- `ReportsPage` now takes `isActive`. It lives in an always-mounted overlay, so
  its fetch-on-mount ran once per session — dispatch could flag a ride, open
  the page and not see it.

**`tsc --noEmit` does NOT catch JSX structure errors here** — an unclosed
ternary producing adjacent JSX elements passed typecheck and failed
`vite build`. Run the build, not just tsc, when changing this file's JSX.

### Fixed during testing 2026-08-16/17

**Auto-open never fired.** The toast and auto-open were side effects inside the
`setRides` updater. React invokes an updater during render and may discard or
double-run it, so `setAlertsOpen(true)` silently did nothing. Both now live in a
`useEffect` keyed off `rides`. **The coverage toast still uses the old pattern
and is likely just as unreliable — move it next time it is touched.**

**Open on load, but silently (2026-08-17).** The panel is the DURABLE state, so
an outstanding flag should be visible immediately after a refresh; the toast and
chime are the EVENT signal and would be lying if they repeated for something
dispatch has already seen. So seeding opens the panel when anything is
outstanding, without announcing. Assignment holds still never auto-open, on load
or otherwise — a company with nobody on shift would have it permanently open.

**A refresh re-announced existing flags.** The effect's first run happens with
`rides === []`, before `fetchRides` resolves, so it seeded an EMPTY baseline and
every existing flag looked new a moment later. Seeding now waits for a non-empty
array.

**A flag on a finished ride never left the panel.** Split into two answers: the
flag ROW stays (it is the record, and Reports reads it), but it leaves the
attention surfaces, because a completed trip is not something dispatch can act
on and stale items are what train people to ignore a panel. Shared `isOpenFlag()`
predicate — flagged, unresolved, not terminal — used by the panel and the
alerting effect so they cannot drift. That created a follow-on gap: such a flag
then had no resolve path at all, so Reports → Ride escalations gained its own
"Mark resolved".

**Notification chime**, for a dispatcher not watching the screen. Synthesised
via Web Audio (two tones, A5→D6) rather than an audio file: nothing to bundle,
nothing for the CSP to block, no fetch at the moment it matters. Lazily created
and resumed, since a context built before a user gesture starts suspended.
Muteable via a 🔔/🔕 toggle in the panel header, persisted in `localStorage`
(`db-alert-sound`).

### Next: the toast is becoming a general channel

Victor wants it reused for driver messages, reports, and more. It is still
called `coverageToast` / `coverageToastTimerRef` and now carries escalations
too. Rename to something neutral (`alertToast`) and give it a type/severity when
the second consumer lands — and move it out of the `setRides` updater at the
same time.

### Still to do

Live test: flag a ride → panel auto-opens with the item, clicking it opens the
ride detail, resolving clears it from the panel; take a company's drivers
offline → an `assignment_hold` item appears and moves the count WITHOUT
auto-opening; Reports → Ride escalations lists both open and resolved.

## Sequencing

Commit Phases 1–2 before starting. Both repos are carrying two phases of
verified-working work plus notes; building Phase 3 on top makes one
undifferentiated diff with no revert point.
