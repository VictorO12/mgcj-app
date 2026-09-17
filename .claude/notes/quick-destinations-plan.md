# Quick destinations → saved places + suggestion engine

Design pass, 2026-09-15. **Phases 1-3 BUILT and OTA-published 2026-09-17** —
see the "BUILT" section at the foot of this file. Parts 2 and 4 below
(the inference engine, popular-nearby) remain design-only and queued.

## What exists today, and why it's worse than it looks

`PassengerHomeScreen.tsx:59` — `QUICK_DESTINATIONS`, four hardcoded Annapolis
Valley landmarks as `{ label, address }` strings. Tapping one
(`:1537-1551`) does **not** set a destination. It calls
`searchPlaces(d.address)` → Places **Autocomplete**, shows predictions, and the
passenger still taps one → `selectPlace` → Places **Details**.

So a "quick" destination costs **two billed Maps calls and two taps**, and can
still resolve to the wrong branch of a chain. A saved place carries its own
coords, so a tap sets `dropoffPlace` directly and jumps to
`setSheet("confirm")` + `getFareEstimate` — **zero Places calls, one tap**.
Against the ~$0.42/ride Maps model and the free-tier cliff, this ships as a
cost reduction that happens to be better UX.

Second problem: the list is **Kentville-specific and hardcoded**, so it ships
verbatim to every future company. Same root cause as the 8+ branding files in
the geo-localization plan. It cannot go in `app.config.js` `extra` (hashed into
both fingerprints → store-build per customer). It belongs on a company-scoped
table read at runtime.

---

## Part 1 — Saved places (the part with no guesswork in it)

`passenger_places`, mirroring `ResolvedPlace` since that is what the booking
path consumes:

```
id, passenger_id (fk profiles), kind ('home'|'work'|'custom'),
name (null for home/work), address (full — the driver needs the civic number),
display (short label for the input row), lat, lng,
created_at, last_used_at
```

- Partial unique indexes: at most one `home`, one `work` per passenger.
  Home/Work are **roles the engine reads** ("near home at 08:00"), not just two
  custom names with nicer icons.
- **No FK from `rides`.** Rides already snapshot `dropoff_address` + coords;
  renaming or deleting a saved place must never touch ride history — same
  freeze reasoning as `completed_at` / `platform_fee_percent_at_completion`.
- Owner-scoped RLS **and** explicit GRANTs in the same migration (post-Oct-2026
  rule — omitting grants still leaves anon/authenticated granted, which would
  make RLS the only thing holding).
- Saving a place is **dropoff and pickup both**. The current chips only fill
  dropoff; the hospital/airport return leg is the obvious case, and scheduled
  bookings need it more than immediate ones. `AddressPickerModal` gets the same
  list so `ScheduledRidesScreen` and the relocate flow benefit for free.
- **Not offered to anonymous/guest sessions.** `signInAnonymously()` makes a
  real auth user and the guest flow *retires* rather than merges on OTP verify,
  so anything saved there orphans.

## Part 2 — The suggestion engine

**Compute it in a plain SQL function (invoker rights, `auth.uid()`-scoped), not
a definer, not a cron-materialized table.** RLS already lets a passenger read
their own rides, so an invoker function is safe by construction and dodges the
revoke-from-anon-by-name trap entirely. One round trip returning 3–5 rows beats
pulling 50 ride rows into the home screen. No cron table — `cron.job_run_details`
disk bloat is a lesson already paid for.

Five things that decide whether this is useful or embarrassing:

1. **Cluster on rounded coordinates (~4 dp ≈ 11 m, or a ~75 m grid), never on
   `dropoff_address`.** That string is passenger-supplied at booking, so the
   same hospital arrives as several different strings and would split into
   several "distinct" destinations. Display label = the most recent string in
   the cluster.
2. **The signal is directional and conditioned on the current pickup**:
   `(pickup cluster, hour bucket, weekday|weekend) → dropoff cluster`. That is
   what makes "at home, 08:00, Tuesday → work" work. Plain global frequency
   gives everyone the same answer all day.
3. **Time granularity: hour-of-day ±90 min, weekday vs weekend.** Finer than
   that is noise at small-town ride volume.
4. **Minimum support, or it will lie in a demo.** A Kentville passenger takes
   ~4 rides/month; n=1 produces a confident nonsense suggestion. Require **n≥2**
   before a time-bucketed suggestion is allowed to rank; below that fall back to
   plain recency.
5. **Suppress any suggestion within ~300 m of the currently-set pickup**, and
   dedupe against saved places by coord cluster.

Score ≈ `frequency × recency_decay × time_bucket_match`.

## Part 3 — One ranked list, not two rows

Pinned saved places → inferred suggestions → curated company fallback, filling
the remaining slots, **deduped by coord cluster** so Home never also shows up as
an inference. Two overlapping chip rows is how this gets noisy.

Cold start (0–2 rides) is exactly the **pitch-demo passenger**, so the fallback
tier is load-bearing, not decoration. Two sources feed it — see below.

## Part 4 — Popular-nearby, derived from aggregate ride data

Amendment 2026-09-15 (Victor's idea): instead of the fallback tier being only a
curated list, derive it from **where everyone else actually goes near this
passenger's live location**. Right call — live pickup beats the company's
registered address, which is just an office.

**The key insight: the privacy gate and the "is this actually popular" gate are
the same filter.** A work commute has **1** distinct passenger. A hospital has
hundreds. So distinguishing a personal commute from a genuinely popular place
needs no separate mechanism — one threshold on **distinct passengers** closes
both problems at once. A cluster qualifies only at, say, **≥5 distinct
passengers and ≥10 completed rides** in the window; below that it is somebody's
home and must never be shown to a stranger.

Rules:

- **`SECURITY DEFINER` is unavoidable here** (a passenger cannot read others'
  rides under RLS) — so `revoke execute ... from public, anon, authenticated`
  **by name**; "revoke from public" alone leaves anon/authenticated granted.
  The function returns only aggregates that already passed the threshold,
  never rows.
- **Scope the pool by `company_id`.** Platform-wide would leak one operator's
  demand map to another operator's passengers. Company is the hard boundary;
  proximity to the live pickup is the ranking.
- **Residential reject, free version:** `display` comes from Places
  `structured_formatting.main_text`. A venue's is "Valley Regional Hospital";
  a house's *is* "12 Oak Street". Reject any cluster whose main_text starts
  with a civic number, on top of the k threshold — k≥5 alone will not stop an
  apartment building.
- **Recency window ~90 days** on the input. Keeps the list current and drops
  the pitch-recording / pre-pipeline ride junk already cleaned up once.
- **Do not time-bucket popularity at launch.** Tempting (bars at 11pm) and
  nearly free to write, but at Kentville volume it fragments counts below the k
  threshold and the list goes empty. Revisit at volume.
- **Do not blend personal and popular into one score.** Frequency-for-this-person
  and crowd-count are different units, so any weight is arbitrary. Personal
  always ranks above popular; popular fills remaining slots. Label the groups
  ("Your usual" / "Popular nearby").
- **This is the one place a cached rollup is justified** — unlike the
  per-passenger engine, this aggregates every ride in the company. Piggyback the
  **existing nightly 3am cron-log cleanup job** rather than registering a new
  one (same reasoning as `reap_stale_drivers` riding
  `scheduled-coverage-monitor`'s cron).

### `company_places` folds into this table — it was never its own feature

Revised 2026-09-15 after Victor pushed back on why a curated table still exists.
Honest answer: it serves exactly one case — **a company without enough ride
volume for the k threshold to return anything.** That is the pitch demo, and
each new customer's first few weeks. Nothing else. It is ~6 rows of seed data
and a fallback branch, not a feature.

So it should not be a second table. One table, `company_popular_places`, with
`source in ('seed','derived')`:

- The nightly rollup **only ever deletes and rewrites `source='derived'`**.
- The read prefers derived rows and falls back to seed rows when fewer than N
  qualify. "Ages out" stops being a metaphor — the seeds are simply outranked
  and eventually never selected.
- Seed rows carry real coords, so they survive the **same proximity-to-pickup
  filter** as derived rows. Checked against M&G's actual service area: the four
  current landmarks span Kentville / New Minas / Wolfville, ~15 km, so a
  Wolfville passenger correctly sees Acadia ranked over a Kentville pharmacy.
  This is what makes one table clean rather than a branching query.

**This does not pull Phase 5 forward.** Phase 2 needs the table, the seed rows,
and the read path only. The nightly rollup job, the k-anonymity threshold and
the `SECURITY DEFINER` aggregate function all stay queued.

**DECIDED 2026-09-15 — no seed tier at all.** Victor chose "try nothing first".
So `company_popular_places` is **not built now**, not even as a table: the chip
row simply does not render when there is nothing personal to show. Consequences,
all accepted:

- `QUICK_DESTINATIONS` is deleted outright rather than migrated. The tenancy bug
  closes for free — there is no longer a hardcoded Kentville list to ship to a
  Halifax customer.
- A brand-new passenger sees no chips until they save a place or take rides.
  For an established company that is a short window; for a new company it lasts
  until volume arrives.
- **Demo protocol changes**: save Home / Work on the demo passenger account
  before recording or pitching. This is arguably a better demo than four
  hardcoded chips — it shows the feature working rather than a static list.
- Do not render the "QUICK DESTINATIONS" section label over an empty list.
  Hide the whole block.

If the empty state turns out to look bad in practice, the seed tier is a table
plus six inserts — cheap to add back, and the `source` column design above is
the shape to add it in.

**Non-blocking flag:** this uses the taxi company's ride data to power a
passenger-facing feature. Normal and defensible, but it is exactly the kind of
clause the MSA/DPA template should name explicitly — and that template is not
drafted yet (see the legal/compliance prelaunch track).

## Also worth having, cheaper than the engine

- **"Rebook" on a past ride** in `RideHistoryScreen` — same data, a fraction of
  the lines, and it covers the "I go there sometimes" case the engine won't.
- **"Save this place"** offered once, right after a ride completes to a
  destination seen ≥2 times and not already saved. Better capture rate than a
  settings screen nobody opens.
- Long-press a chip → rename / unsave / set as Home.

## Suggested build order

1. `passenger_places` + saved-place chips + direct-coord booking (kills the two
   Places calls). Standalone value, no engine needed.
2. ~~Seed tier~~ — **dropped 2026-09-15**, see above. Deleting
   `QUICK_DESTINATIONS` in step 1 closes the tenancy bug on its own.
3. Rebook from history.
4. The personal suggestion RPC + merged ranking.
5. Popular-nearby rollup + k-anonymity gate. Last, because it is worthless until
   real ride volume exists — and it is the tier that ages the seed out.

## Open questions for Victor

- ~~Dispatch-editable vs Vellon-seeded `company_places`~~ — moot. It is seed
  rows in `company_popular_places`, Vellon-inserted at onboarding, outranked by
  real data as volume arrives. No dashboard screen, no separate table.
- Exact k threshold (starting proposal: ≥5 distinct passengers, ≥10 rides, 90d).
- Cap on custom saved places per passenger?


---

## Build log — phase 1, 2026-09-15

Written, typechecked, **migration NOT yet applied**:

- `supabase/migrations/20260778_passenger_places.sql` — table, 20-row cap
  trigger, revoke-then-grant, owner-only RLS on all four verbs.
- `src/lib/savedPlaces.ts` — fetch / save / delete / re-kind / touch, ordering
  (Home, Work, then most-recently-used), and `findSaved` for the save button.
- `src/components/SavePlaceModal.tsx` — Home / Work / Other + a name field.
- `PassengerHomeScreen.tsx` — `QUICK_DESTINATIONS` deleted; chip row is
  data-driven; a chip tap sets the destination from stored coords and goes
  straight to confirm; long-press gives Set as Home / Work / Remove; saved
  places also list inside the search sheet, which is the only route to a saved
  **pickup**; "Save this place" on the confirm sheet.
- `AddressPickerModal.tsx` — same list, so `ScheduledRidesScreen` and the
  relocate flow get saved places too.
- `types/index.ts` — `is_guest` added to `Profile` (AuthContext already
  selected it; the type was stale).

Deliberate gaps: **no rename** (remove and re-save — `Alert.prompt` is
iOS-only and a rename modal isn't worth it yet), and no dedicated
manage-places settings screen.

Until the migration is applied the app degrades correctly rather than by luck:
`fetchSavedPlaces` logs the PostgREST error and returns `[]`, so the chip row
does not render.


---

## Empty-state brainstorm, 2026-09-15 (Victor: "downtown Halifax has too many places")

Two reframes change the problem before any option gets evaluated.

**1. Density argues AGAINST a curated list, not for one.** In downtown Halifax
any fixed list of 6-10 places is almost certainly wrong for this passenger. The
denser the area, the lower a fixed list's hit rate. The intuition ("so many
places") is real and it is evidence the slot should not hold a *list* at all.

**2. The empty state is far rarer than we have been treating it.** `rides`
already carries `dropoff_address` + coords, and `RideHistoryScreen` reads them
under existing RLS. So **recent destinations** — this passenger's last 3-5
distinct dropoffs, deduped on the same 4dp coord bucket, suppressed within
~300 m of the current pickup — fills the slot for anyone with a single
completed ride. No new table, no Places call, no privacy surface. That is
Phase 3's "rebook", promoted from the history screen into the chip row, where
it is strictly more useful.

After that, the only passenger seeing nothing is one with **zero rides and zero
saved places**. And for them the right content is not destinations at all:

**Empty Home / Work slots.** Two placeholder chips ("Add Home", "Add Work")
that open the save flow against a searched address. It converts dead space into
onboarding and *manufactures* the data that fills the slot permanently. It is
also what the apps in the competitor teardown do.

### Recommendation

`saved -> recents -> empty Home/Work slots`. Covers everyone, needs no seed
list, no cross-passenger data, and no Maps spend.

### Also on the table

- **"Set destination on map"** — pin-drop from the idle state. The one filler
  that is not a list: works in any country with no data at all, and covers the
  rural / no-civic-address case this service area genuinely has.
- **"Paste address"** — shown only when the clipboard holds something
  address-shaped. Passengers get addresses by SMS constantly, and it suits the
  "I already know where I'm going" taxi passenger better than any discovery UI.
- **Contextual non-destination content** in the slot: an upcoming scheduled
  ride, drivers-nearby state, the existing card nudge.

### Explicitly rejected: Places Nearby Search for "popular places"

This is what the Halifax intuition reaches for. Nearby Search is one of the most
expensive Maps SKUs, it returns tourist POIs rather than taxi destinations, and
it would undo the very cost argument that justified replacing the old chips.

### Consequence for Part 4

**The k-anonymity popular-nearby tier is now the WEAKEST tier, not the crown
jewel.** Recents fill the same slot for the same passenger with none of the
SECURITY DEFINER function, residential filtering, or nightly rollup machinery.
Keep it queued; it is last and optional.

---

## BUILT 2026-09-17 — tiers 1-3

`passenger_places` verified live before building on it (anon probe returned
42501 `permission denied`, not `PGRST205`, which is the shape that proves the
table exists *and* that the `REVOKE ... FROM anon` in 20260778 took). Worth
doing: `fetchSavedPlaces` swallows its error and returns `[]`, so an unapplied
migration renders pixel-identically to "this passenger has saved nothing" — and
the empty-slot tier would then have looked like a working feature sitting on
top of a dead one.

**Tier 2 — recent destinations** (`src/lib/recentPlaces.ts`). No migration, no
Places call, no new privacy surface: the passenger's own last 20 `completed`
rides, deduped on the same 4dp coord bucket as saved places, newest first.
Four decisions:

- Ordered by **`completed_at`**, never `updated_at` — house rule for anything
  time-ordered off `rides`.
- **`status = 'completed'` only.** A cancelled ride's dropoff is a place they
  never went.
- **Suppressed within ~0.003° (~330 m) of the current pickup.** The most recent
  dropoff is very often exactly where they're standing, so without this the
  most common case shows the most useless chip. Plain delta box, not haversine
  — it reruns on every pickup change and the tolerance dwarfs the difference.
- **Chip label = first comma segment** (`shortLabel`), because `rides` has no
  `display` column. Degrades correctly both ways: a venue address gives the
  venue, a civic address gives the street.

**Tier 3 — empty Home/Work slots.** Renders only when saved *and* recents are
both empty, i.e. a genuinely new passenger. Reuses `AddressPickerModal`
standalone (kind is already known, so `SavePlaceModal` is skipped) rather than
threading a "next resolved place becomes Home" flag through the booking search
sheet, which would have fought `activeField`/`searchTouched` for the same UI.
`PickedAddress` gained an optional `display` so the saved row gets a real short
label instead of a re-derived one.

**One row, not two.** Saved chips then recent chips in a single horizontal
scroll, capped at 6 total (`QUICK_ROW_MAX`) — saved chips are `slice`d to that
cap too, not just recents, or the cap is fiction at 20 saved places. The `SAVED PLACES` section label
is **gone** — over a mixed row it was wrong, and in a sheet whose job is the
address fields it was the loudest element. Same merge in the booking search
sheet's before-you-type list.

Also folded in: long-pressing a **recent** chip saves it. That is the best
capture point in the app — somewhere they have demonstrably been twice — and it
is what turns tier 2 into tier 1 over time. Required lifting the save modal's
address off `dropoffPlace` onto a `pendingSave` state, since the idle row has
no destination set.

**Not done / next:** device check of the three states (empty, one saved place,
mixed row) — none of which are reachable from Victor's own account without
clearing rows. Phase 4 (inference engine) and Phase 5 (k-anonymous popular
nearby) stay queued, and per the reframe above Phase 5 is now the weakest tier,
not the crown jewel.
