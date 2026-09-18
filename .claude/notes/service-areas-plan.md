# Service areas + per-company map framing

Design pass, 2026-09-17. **No code written yet** — design-before-build, and two
questions below are Victor's to answer, not mine.

Sibling to `geo-localization-plan.md` (2026-09-13). That note covers *display*
localization (timezone, locale, currency, phone). This one covers *geography*:
where the map opens, and where a company will actually pick you up. They share
one migration target (`companies`) and should land in that order — geography
first, because it is the one with a booking-refusal in it.

---

## 0. PostGIS — answered 2026-09-17

```
name     default_version  installed_version
postgis  3.3.7            null
```

**Available, not installed.** So it is one statement, not a platform decision:

```sql
create extension if not exists postgis with schema extensions;
```

Two notes on doing it. Supabase's convention is the `extensions` schema, not
`public` — installing into `public` pollutes the PostgREST-exposed namespace with
several hundred spatial functions. And it brings `spatial_ref_sys` (~7 MB of
projection definitions) with it; irrelevant against the 2 GB free-tier ceiling,
but it is real disk and worth knowing it appears without anyone adding it.

Take this path. Rationale in §3; the hand-rolled alternative is kept only as a
footnote now that the answer is known.

---

## 1. What is actually hardcoded today (grepped, not assumed)

Three sites, one constant, two different severities:

| Site | Role | Severity |
|---|---|---|
| `PassengerHomeScreen.tsx:164` `VALLEY_REGION` | `initialRegion`, until GPS resolves | Low — a sub-second flash |
| `DriverHomeScreen.tsx:154` `VALLEY_REGION` | `initialRegion`, until GPS resolves | Low — same |
| `DashboardPage.tsx:1852` `center: {45.0773, -64.3601}` | The dispatch map's **only** framing | **High** |

The two app sites are the ones Victor noticed, and they are the *less* important
pair. A phone has GPS; the wrong frame is visible for as long as the fix takes.
**The dashboard has no GPS at all** — a dispatcher in Montreal opens their map
over the Annapolis Valley and stays there, every session, forever. That one is
not cosmetic.

Also geographic, same root cause, listed so the sweep is complete:
`components=country:ca` at `PassengerHomeScreen.tsx:887` and
`AddressPickerModal.tsx:143`, plus the `", Canada"` suffix-strip at
`PassengerHomeScreen.tsx:102`. Covered in `geo-localization-plan.md` Tier 2;
not re-litigated here beyond §6.

---

## 2. Framing: don't relocate the constant, delete it

Victor's proposal was to snap to the company's address. Right instinct, wrong
column, and there is a better source sitting in the feature itself.

**Why not `companies.billing_address`:**
- It is a *billing* address. M&G's reads `56 Route 358 Greenwich NS B4P 2R2` —
  ~15 km from where their cars actually are. Framing a dispatch map on an
  accountant's mailing address is a coincidence when it works.
- It is free text, so it needs a geocode round-trip to become a map centre.
- **3 of 4 live companies have it NULL.** Only M&G Cab Ltd has one. A fallback
  that is null for most rows is not a fallback.
- It answers position but never *extent*. It cannot tell you whether to frame
  2 km or 60 km, so a hardcoded zoom constant survives — the exact thing we are
  trying to kill.

**The service-area polygons are the framing data.** Once a company has drawn
where it serves, the correct frame is the bounding box of the union of its
active areas, fitted with padding. That answers position *and* extent from one
source, with no constant anywhere: a one-town company gets a tight frame, a
company serving Kentville **and** Halifax gets a frame wide enough to show both,
and nobody picks a number. This also means the drawing UI is self-demonstrating
— dispatch draws the area, and the map they stare at all day reframes to it.

**Fallback chain** (first non-null wins), per surface:

```
dashboard:  bbox(active service areas)  ->  service_center_lat/lng  ->  valley constant
app:        device GPS fix              ->  bbox(active service areas)  ->  service_center_lat/lng  ->  valley constant
```

`service_center_lat/lng` is a nullable pair on `companies`, captured at
onboarding by dropping a pin ("where is your dispatch office / main stand?").
It exists for the window between a company being created and its first polygon
being drawn, and as the answer for a company that never draws one. The valley
constant stays as the floor for a brand-new empty company — it is a defensible
last resort, just not a default.

Note the app keeps GPS **first**. A passenger's own location beats the company
centroid: the tighter 0.03 frame shipped in `7a570ea` is about them, not the
company. Company framing is only the pre-fix / denied-permission case.

---

## 3. Data model

### If PostGIS is available — the recommended path

```
service_areas
  id            uuid pk
  company_id    uuid not null references companies(id) on delete cascade
  name            text not null        -- 'Kentville + New Minas', 'Halifax Stanfield'
  area            geography(MultiPolygon, 4326) not null
  allows_pickup   boolean not null default true
  allows_dropoff  boolean not null default true
  active          boolean not null default true
  -- editor round-trip only; NEVER read by containment (see below)
  shape_kind      text not null default 'polygon'   -- 'polygon' | 'circle'
  center_lat      double precision
  center_lng      double precision
  radius_m        numeric
  created_at      timestamptz not null default now()
  -- GiST index on area
```

**`allows_pickup` / `allows_dropoff` are the whole model** (Victor, 2026-09-17 —
supersedes the "dropoff unrestricted" recommendation below, see §4). One table
expresses every case an operator has:

| Area | pickup | dropoff | meaning |
|---|---|---|---|
| Kentville + New Minas | ✓ | ✓ | the home territory |
| Halifax Stanfield | ? | ✓ | a destination they'll drive to |
| Montreal | — | — | never drawn, therefore refused |

A "named far destination" needs no separate concept: it is a service area with
`allows_pickup = false`. Building it as its own table would mean a second
geometry store with its own containment path, and the first thing anyone would
ask of it is "can I make it a bit wider" — which is a polygon.

**Circles are load-bearing, not a nicety.** Tracing the airport freehand is the
step where an owner gives up, so the primary flow for a destination area is
Places search → drop a pin → drag a radius; freehand polygons are for the home
town. `shape_kind`/`center_*`/`radius_m` exist **solely to round-trip the
editor** so a circle re-opens as a circle. `area` is generated from them at save
(`ST_Buffer` on the geography) and is the **only** thing containment ever reads.
Two sources of truth for "is this point inside" is exactly how the client/server
fare split happened — twice.

`MultiPolygon`, not `Polygon`, and multiple rows per company on top of that. Two
different kinds of "multiple" and both are wanted: several **named** areas a
dispatcher can toggle independently (Victor's requirement), and a single named
area that is geographically disjoint (a town plus an outlying village served
from the same stand).

Containment is `ST_Covers(area, point)` — `Covers`, not `Contains`, so a pin
dropped exactly on a boundary resolves in the passenger's favour rather than
falling in a hairline crack.

**`company_serves_point()` is `SECURITY DEFINER` and granted to
`authenticated`** (decided while writing the migration, 2026-09-17 — the first
draft had it INVOKER). INVOKER reads through RLS, so it answers *"served"* for
any session that cannot see the company's rows: a passenger whose
`get_my_company_id()` does not match the ride's company, a guest booking with no
session. Those are exactly the inserts worth checking, and the function would be
inert for them while looking correct everywhere else — one implementation that
behaves differently depending on the caller is not one implementation. As
DEFINER it gives the same answer to the trigger, to dispatch, to a passenger
pre-checking an address, and to service_role, which is also what lets the
clients grey out an unserved address **by calling it** rather than
reimplementing point-in-polygon in JS. Exposing it is safe in a way most
definers are not: company id in, boolean out, about information the company
advertises — no rows, no writes. `anon` is still revoked by name.

**The "serves everywhere" default is per-END, not per-company.** A company that
draws only destination areas has `allows_pickup = false` on every row; a
per-company early-out would leave it with no pickup area and refuse every
booking it takes, silently. Per-mode means the end they have not described
stays open. Framing is `ST_Envelope(ST_Union(...))`; the
onboarding centre could even be `ST_Centroid` once a polygon exists.

`geography` over `geometry` deliberately: metres are the unit anyone will
reason in, and it survives the platform leaving Canada — which is the stated
goal of this whole exercise.

### The hand-rolled alternative, for the record

`jsonb` rings + a precomputed bbox + ray-casting in plpgsql. Workable at these
table sizes, and now moot — but the reason to reject it is worth keeping, since
it generalises: the containment function sits on the **booking-refusal** path,
so a subtle bug in a hand-rolled point-in-polygon does not degrade gracefully.
It turns paying customers away, and silently, because a refused passenger just
closes the app.

### `companies` additions (same migration)

```
service_center_lat        double precision  -- nullable, onboarding pin
service_center_lng        double precision
long_trip_confirm_km      numeric not null default 150   -- see §4a
```

Post-Oct-30-2026 GRANT statements on `service_areas` in the same migration, per
the standing convention. RLS: staff-read/write scoped by `get_my_company_id()`;
**passengers need read access to their own company's areas** for §6's client-side
prevention, so that is a second, narrower select policy — and it is worth being
deliberate that a company's service map is not especially secret.

---

## 4. Enforcement — four doors, not one

A `BEFORE INSERT` trigger on `rides` is the right chokepoint and matches the
existing family (`guard_ride_fare_fields`, `guard_ride_payment_method`,
`guard_ride_claim_fields`). It is not sufficient on its own.

**Door 1-3 — the three insert sites.** `PassengerHomeScreen.tsx:1219` (card),
`:1266` (cash), `DashboardPage.tsx:3227` (dispatch). All three write `rides`
directly from a client, so the trigger is the only thing that sees all of them.

**Door 4 — `edit-ride`'s `relocate`.** Book a legal ride, then move the dropoff
to Montreal. This is the *identical* shape to the bug `edit-ride` was built to
close (move the destination, leave the fare pinned), arriving through the same
door a second time. An INSERT-only guard misses it completely. And because
`edit-ride` runs service-role — which every existing guard exempts, correctly —
**it must run the check itself**. This is the vehicle-class surcharge trap
restated: a new server-side path that forgets to pass the new input silently
reverts the fix with nothing failing loudly.

**Ordering: check before `create-payment-intent`, not after.** That function
runs *before* the ride row exists. A trigger-only design takes the Stripe hold,
then the insert refuses, and the passenger is left with a ~7-day authorization
for a ride that does not exist. The service-area check belongs at the top of
`create-payment-intent` as well as in the trigger — cheap, and the trigger stays
as the backstop that cannot be bypassed.

**Pickup and dropoff are different rules — resolved 2026-09-17, revised the
same day.** Victor's two examples are two different checks:
- *"someone in Montreal booking to Halifax"* — **pickup** outside the area.
- *"Kentville to Halifax if they don't support it"* — **dropoff** outside.

**First answer (superseded): pickup strict, dropoff unrestricted.** Reasoning
was that the codebase itself treats "a Kentville → Halifax airport run" as the
canonical normal fare (`updates.ts:29`, `assign-ride/index.ts:91`), so refusing
long drop-offs would turn away the best fare on the board.

**Revised answer: both sides are allowlists, per area.** Victor pushed back —
he does not want Montreal bookable at all, and the ~$1,985 hold in §4a is why.
That is correct and it supersedes the above. The unrestricted-dropoff model has
no ceiling on it *anywhere*: it permits every destination on the continent in
order to permit the airport, and the fare formula behind it is linear and
uncapped. An allowlist permits the airport and nothing else.

So the rule is simply:

```
pickup  must fall in an active area with allows_pickup  = true
dropoff must fall in an active area with allows_dropoff = true
```

What this buys, beyond matching what operators actually want: **the catastrophic
fare becomes structurally impossible rather than confirmable.** The worst
possible ride is now bounded by the furthest area an operator chose to draw, not
by how far the Places API can autocomplete. That is a much better property than
any amount of confirmation UI, because it does not depend on a passenger reading
a dialog.

The cost, stated plainly: **a legitimate destination nobody drew is refused,
silently** — the passenger just closes the app. Three things mitigate it, and
all three are already in this design: dispatch override (below), the permissive
zero-area default (§4, rollout defaults), and the refusal readout in §5, which
stops being a nice touch and becomes the main safeguard.

There is still **no `dropoff_policy` column** — it was a company-wide flag, and
the per-area booleans say everything it could say, more precisely.

**Dispatch overrides, it is not refused.** An airport run taken over the phone,
outside the drawn area, is legitimate revenue. Mirror `edit-ride`'s existing
admin asymmetry exactly: hard refusal for passengers, **confirmable warning**
for admins (`confirm_out_of_area`, same shape as its `confirm_conflict`). A
dispatcher who cannot book what the owner just agreed to on the phone will stop
using the dashboard.

### 4a. The long-distance question is a *pricing* problem, not a boundary one

This is the part Victor was unsure about, and the reason it feels unresolved is
that two different problems are wearing the same coat. Drawing a boundary does
not touch either of the ones that actually bite on a long trip:

**(i) The fare formula is linear and uncapped.** `fareFromMetres` is
`base + km × rate`, full stop — no cap, no tier, no minimum, and grep confirms
no flat-rate or named-route concept exists anywhere in the platform. At M&G's
live numbers (`base_fare` 5.0, `rate_per_km` 1.8) that is about **$158 for the
~85 km airport run** — roughly sane — and about **$1,985 for Kentville →
Montreal**. A passenger who mis-taps an autocomplete result gets a Stripe
authorization for two thousand dollars against their card.

**This number is what killed the unrestricted-dropoff model** (§4). Under the
per-area allowlist the $1,985 ride is not confirmable, it is unreachable —
Montreal is simply never drawn, so the ceiling is the furthest area the operator
chose, not the reach of the Places API.

**`companies.long_trip_confirm_km` survives anyway, for a smaller reason.** It
is no longer a rail against catastrophe; it catches the *bounded but surprising*
case — passenger means Kentville Mall, taps Halifax Stanfield, and gets a real
$158 charge for a ride they did not intend. So: past the threshold, an explicit
"this is an 85 km trip, about $158 — continue?", for the passenger and for
dispatch. A **confirmation, not a refusal**: the trip is legitimate, the mis-tap
is not, and only the passenger can tell them apart. The default should now sit
*below* the furthest drawn area rather than the 150 km picked when the ceiling
was unbounded — for M&G that means something like 50 km.

**(ii) Deadhead is unpriced.** A linear rate charges one direction; the driver
drives back empty. On a town trip that is noise. On an 85 km airport run it is
half a shift, half of it unpaid — which is precisely why real taxi operators
price airport work as a flat named rate rather than per-km. Whether M&G's 1.8
already has a return leg baked into it is **a question for the owner**, not one
to infer from the schema.

**Out of scope here, deliberately.** Long-trip pricing (return multipliers past
a threshold, flat named routes, an airport rate) is its own project touching
`fare.ts` — the single source of truth three functions bundle separately and
must redeploy together. Folding it into service areas would put the fare formula
in play inside a migration about polygons. Named so it is not discovered later.

**Where it will land, though — now designed, see §10** — and this is the quiet
payoff of Victor's allowlist idea: a named destination area is exactly the unit
a flat airport rate attaches to. `service_areas.flat_fare` (or a per-area return multiplier) is the
natural home for the deadhead fix, and it only exists because destinations
became first-class rows. The boundary design made the deferred pricing project
easier, not just the boundary one.

**Two rollout-safety defaults, decided consciously here rather than discovered
in production:**
1. **Zero active areas = serve everywhere.** Day one, all four companies have no
   polygons; a default-deny would refuse every booking on the platform the
   moment the migration lands. Same reasoning as `last_seen_at IS NULL = live`:
   the permissive default is what makes a non-atomic rollout safe.
2. **NULL `company_id` on the passenger bypasses the check.** There are **6 such
   passengers live right now** (10 are on Northstar Taxi, 2 on M&G original).
   With no company there is no area to test against. Worth flagging separately
   that those 6 currently insert rides with a NULL `company_id` at all — that is
   a pre-existing multi-tenancy gap this note only touches, does not fix.

---

## 5. Dashboard: Settings -> Service Areas

`SettingsPage.tsx:44` already has the admin-gated section list
(`pricing`, `vehicle_classes`, `numbering`, `team`, `support`). Add
`service_areas` between `vehicle_classes` and `numbering`.

Shape: a Google Map with the Drawing library. **Two ways to add an area, and the
second one matters more than it looks:**

1. **Draw a polygon** — freehand, for the home territory. Re-opens with
   draggable vertices.
2. **Search a place → drop a pin → drag a radius** — for a destination. This is
   the flow that makes "add the airport" a 10-second job instead of the fiddly
   tracing exercise where an owner gives up and leaves the feature unused.
   Re-opens as a circle (§3's `shape_kind` round-trip).

Each area in the list beside the map carries: name, an `active` switch, a
visibility toggle, and — the part that does the real work — **two checkboxes,
"pick up here" and "drop off here."** That pair is the entire policy surface.
The home town has both; the airport likely has dropoff and maybe pickup;
anywhere undrawn is refused by omission.

Two UI decisions worth stating now, because they are cheap to get right and
expensive to retrofit:
- **Refuse to save a state that refuses everything.** The database now fails
  open per-end (§3), so an all-`allows_pickup = false` area set does not cause
  an outage — but it is still never what the owner meant. The editor should
  block the save and say which end has no area, rather than letting the DB
  quietly paper over it.
- **Show the drivers on it.** Overlaying live driver positions while drawing is
  how an owner sanity-checks the shape against where their cars actually are.
  The data is already on the dashboard map.
- **Show what it would have refused — this is now the main safeguard, not a
  nicety.** Recomputed on save, against the last 200 rides, and reported as
  **two separate numbers**: how many would have been refused on *pickup* and how
  many on *dropoff*. Under the allowlist those are different mistakes — a
  too-tight home polygon versus a destination nobody remembered to add — and a
  single blended count would hide which one the owner just made. This matters
  more than it did in the first draft: the moment a company draws its *first*
  area, every previously-legal out-of-town dropoff becomes a refusal, and the
  refusal is silent, because a turned-away passenger just closes the app. This
  readout is the only thing standing between an owner and quietly losing their
  airport business the day they start using the feature.

Existing map gotcha applies: keep the div mounted and hide with `visibility`,
never conditionally unmount, or the map reinitialises on tab switch.

---

## 6. Client-side, so a passenger rarely meets the refusal

A server refusal at booking is the backstop, not the experience. The passenger
should mostly not be able to *choose* an unserviceable pickup:
- Bias / restrict Places autocomplete to the area bbox at
  `PassengerHomeScreen.tsx:887` and `AddressPickerModal.tsx:143` (the two
  `components=country:ca` sites — the same two `geo-localization-plan.md` wants
  to make country-dynamic; do both edits in one pass).
- When a pin does land outside, say so in the booking sheet in the operator's
  words — "M&G doesn't pick up in this area yet" — not a generic validation
  error. This is also the one honest place to offer a "request this area"
  signal, which is free market research for the operator.

---

## 7. Scope fences

- **Nothing geographic goes in `app.config.js`'s `extra`.** It is hashed into
  both platform fingerprints (measured 2026-08-24), so a service area in `extra`
  makes every new customer a store-build event. It lives in the `companies` /
  `service_areas` rows, read at runtime.
- **Service areas do not touch `assign-ride` or any driver-side dispatch.**
  They constrain what a *passenger may book*. A driver who drives out of the
  area on a legitimate fare is not doing anything wrong, and a liveness/
  dispatch filter that quietly drops them would be a new phantom class.
- **One resolver per side**, `fare.ts` / `presence.ts` pattern:
  `_shared/serviceArea.ts` for edge functions, a hook/context per client. Not
  re-fetched at N call sites.
- Distance stays metric internally throughout; see `geo-localization-plan.md` §5.

---

## 8. Decisions log

All three opening questions are answered; recorded here so the reasoning
survives the conversation.

1. **PostGIS** — available 3.3.7, not installed. **Enable it** (§0).
2. **Long drop-offs** — answered twice, and the second answer is Victor's.
   First pass: *"they do airport runs and other long distances, but it's a local
   taxi company at large"* → pickup strict, dropoff unrestricted. He then
   rejected that on the strength of §4a's $1,985 Montreal hold and proposed
   letting admins nominate specific far destinations and choose pickup/dropoff
   per one. **That is the better model and it supersedes mine.** It needed no
   new concept — it is `allows_pickup` / `allows_dropoff` on the areas table
   (§3), which turns the catastrophic fare from *confirmable* into
   *unreachable*. The residual hazard is the reverse one: a legitimate
   destination nobody drew, refused silently. §5's split refusal readout is the
   mitigation and is now load-bearing.
3. **Airport pickups — not a question, a checkbox** (Victor, 2026-09-17). I had
   this in the open list as "does M&G want inbound airport pickups." Wrong
   altitude: there is no platform-level answer, because we are not building for
   M&G — we are building for every operator we can sign, and they will disagree
   with each other. One will work the airport stand, the next will only drop
   there. So the design does not *infer* the flag from a business type, it
   *asks*: both checkboxes are presented explicitly when an area is drawn. Worth
   keeping as a standing check on this whole note — any place where I reason
   from "what M&G would want" to a hardcoded default is a place a second
   customer breaks.
4. **Passenger outside every area** — *"doesn't operate in this area first."*
   A per-company refusal, no cross-company suggestion, no marketplace.
   `service_areas` stays scoped by `company_id` with no global area index, and
   the passenger→company binding is untouched. The marketplace reading ("here
   are the companies that do serve you") is a different product and is **not**
   being designed around; if it ever arrives it wants its own note, not a
   generalisation of this schema.

Still genuinely open, but not blocking a build:

- **The 6 passengers with NULL `company_id`** (of 18; 10 on Northstar Taxi, 2 on
  M&G original). With no company there is no area to test against, so §4
  bypasses the check for them. Safe for this feature, but it papers over a real
  multi-tenancy gap — those passengers also insert rides with a NULL
  `company_id`. Pre-existing, named here, not fixed by this work.
- **Whether `rate_per_km` already assumes a return leg** — §4a (ii). One
  question for the owner; the answer changes the long-trip pricing project, not
  this one.

---

## 9. Build order, once approved

1. `create extension if not exists postgis with schema extensions;`
2. Migration: `service_areas` (geometry + the two booleans + circle round-trip
   fields, GiST, RLS, post-Oct-30-2026 GRANTs), `companies.service_center_lat/lng`,
   `companies.long_trip_confirm_km`.
3. `_shared/serviceArea.ts` + the containment SQL function. **Verify live** that
   the function and policies exist before anything depends on them — repo
   migrations record intent, not applied state.
4. Dashboard: Settings → Service Areas (§5), including the split refusal
   readout. Drawing must ship **before** enforcement, or the first enforced
   company has nothing drawn and refuses everything.
5. Framing off the polygons: dashboard first (§1 — the surface with no GPS),
   then the two app `initialRegion` sites.
6. Enforcement last, all four doors in one pass (§4) — the `rides` trigger, the
   `create-payment-intent` pre-check, `edit-ride`'s own check, and the dispatch
   confirm path. Splitting this across commits leaves a half-guarded window.
7. Client-side prevention (§6) and the long-trip confirmation (§4a).

---

## 10. Per-area pricing — designed 2026-09-17, deferred

Victor's question: should an admin be able to set a different rate or formula in
a selected area — e.g. a cheaper airport run, to stay competitive?

**Yes, and this is its correct home.** It is a real commercial need (airport and
inter-town work is exactly where operators compete on a published number), and
§4a already established that the deadhead problem wants a per-destination rate.
Named areas make both reachable with one column family. But it is **not** a
small feature, and three traps have to be settled *before* any column is added.

### Trap 1 — which area prices the ride? (revised 2026-09-17)

**First answer, wrong: "the dropoff area prices the ride."** Victor broke it in
one line — an airport run is one-way so it reads fine, but a trip *in and out of
the city* would price differently in each direction. Kentville → Halifax picks
up Halifax's discounted rate; Halifax → Kentville picks up the home rate. Same
two points, same distance, two prices, and the passenger sees it.

That asymmetry is not just confusing, it is usually not what the operator meant.
Economically the two directions cost about the same: outbound the driver
deadheads home, inbound they deadheaded out to get there. An operator quoting
"the airport run" means a number, not a direction.

**Revised rule: the *non-default* end prices the ride.** Whichever end of the
trip falls in an area carrying a pricing override decides the fare, regardless
of whether that end is the pickup or the dropoff. The home territory carries no
override, so it never competes.

```
Kentville -> Halifax   ->  Halifax override    -> $X
Halifax   -> Kentville ->  Halifax override    -> $X   (same, by construction)
Kentville -> New Minas ->  no override anywhere -> company default
Halifax   -> Airport   ->  two overrides       -> priority decides (Trap 2)
```

Symmetric by construction, no direction field, no O(n²) zone matrix, and it
degrades to today's behaviour the moment nobody sets an override.

**One edge case it forces into the open:** a flat fare is a property of a
*journey*, not of a neighbourhood. If Halifax carries a flat $120 and someone
books a 2 km hop *within* Halifax, the naive rule charges them $120. So:

> When a single priced area contains **both** ends, the trip is intra-area — use
> that area's `base_fare`/`rate_per_km` override if it has one, and **ignore its
> `flat_fare`**. A flat fare applies only when exactly one end is inside.

**Deliberate asymmetry, if anyone ever wants it**, is a separate opt-in and not
built now: a cheap *backhaul* (discount the return leg to fill a car that is
driving home empty anyway) is a real yield tactic, and it would be a `direction`
column on the override — `'either' | 'inbound' | 'outbound'`, defaulting to
`'either'`. Named so the symmetric rule above is understood as a default rather
than a limitation. Do not build it until an operator asks.

### Trap 2 — overlapping areas

The airport circle will sit *inside* a broader Halifax polygon. Both match the
dropoff; both may carry a price. This must be deterministic or the same ride
prices differently on two different days.

Recommend an explicit `priority integer not null default 0`, highest wins, ties
broken by smaller `ST_Area`. Smallest-wins alone is tempting and needs no
config, but it surprises people the moment a shape is drawn oddly, and a
pricing rule nobody can predict is worse than one they have to set.

### Trap 3 — the formula already lives in four places, and that is the real risk

This is the one that decides whether the feature is safe to build:

| Where | What it computes |
|---|---|
| `_shared/fare.ts` | the authoritative server fare (3 functions bundle it separately) |
| `PassengerHomeScreen.tsx:963` | client quote, reads `companies.base_fare/rate_per_km` directly |
| dashboard `fareForDistance` | dispatch quote, same shape |
| `DriverActiveRideScreen.tsx:1134` | hardcoded `4 + km * 1.8` — already disagrees with the live company row |

Adding per-area pricing to a formula that is duplicated four ways **recreates
the vehicle-class surcharge bug on a larger surface**: the client would quote
the cheap airport rate while the server held the standard one, and — exactly as
before — an undercharge generates no complaint from either side, so it survives.
There is no `quote-fare` function today; every client computes its own.

**So the precondition is: stop duplicating the formula.** Add a `quote-fare`
Edge Function that takes origin/destination/vehicle class and returns the
number, and have both clients call it instead of computing. Per-area pricing
then has exactly one implementation, and the fourth copy in
`DriverActiveRideScreen` gets deleted on the way past. This is worth doing on
its own merits; per-area pricing just makes it non-optional.

### Shape, once those are settled

```
service_areas
  pricing_mode  text not null default 'inherit'  -- 'inherit' | 'flat' | 'rates'
  flat_fare     numeric     -- pricing_mode = 'flat'
  base_fare     numeric     -- pricing_mode = 'rates', null = inherit company
  rate_per_km   numeric     -- ditto
  priority      integer not null default 0
```

Two details that follow from existing lessons, not from taste:

- **Order of operations with the vehicle-class surcharge must be stated once, in
  `fare.ts`.** The surcharge multiplies the *whole* fare, base included. A flat
  airport fare almost certainly still takes the van surcharge — but that is a
  decision to write down, not to leave to whichever caller runs first.
- **A rate change must not re-price history.** Fares are already frozen onto the
  ride row, so bookings are safe; the exposure is any analytics that recomputes
  from live area rates. Same family as `completed_at` and
  `platform_fee_percent_at_completion`: never bucket or re-derive money from a
  mutable config row.
- **`edit-ride`'s `relocate` must re-price through the same resolver.** Moving a
  dropoff from town to the airport changes which area prices the ride, and that
  path already re-authorizes Stripe in both directions.

### Sequencing

Ship **after** service areas exist and are drawn — the areas are the unit this
attaches to, and drawing needs to be in operators' hands first anyway. The
`quote-fare` consolidation can start any time and is the actual long pole.
