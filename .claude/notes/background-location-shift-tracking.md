# Background location — whole-shift tracking + breadcrumb history

Status (2026-09-11): STEPS 1-4 BUILT, all migrations through 20260771 APPLIED
and verified live, and step 1 is RUNNING ON A DEVICE (iOS `preview` build
46ae4f84, runtime `e934f5dc…`). Breadcrumb history survives a locked walk as of
walk 2. One defect open — live position/heartbeat still stall while the phone is
locked; see "The keychain is the answer". Step 5 (store build) is blocked on
that and nothing else. Supersedes the "active rides only" section of
`liveness-rework-design.md`, which is now wrong on one axis.

## Why the earlier note was wrong

It scored all-shift tracking as "dispatch convenience". It isn't: whole-shift
visibility is a **sales wedge** — it displaces per-vehicle GPS tracker hardware
(~$25-40/vehicle/month, plus install) for the taxi company. GPS tracker products
sell *history*, not just a live dot. That makes this revenue-bearing, and it
changes the answer.

What survives from that note: the passenger-side bug is real and unchanged (the
car and ETA freeze whenever the driver backgrounds the app — a phone call, a
screen lock, or using their own nav app for the whole fare).

## One mechanism, two cadences

Not two features, and not one uniform setting.

| | idle on shift | active ride |
|---|---|---|
| accuracy | `Accuracy.Balanced` | `Accuracy.High` |
| trigger | `distanceInterval` ~150m | `timeInterval` 5-10s |
| consumer | dispatch map, breadcrumbs | passenger car + ETA, breadcrumbs |
| escalation | — | on ride start, drop back on ride end |

A parked driver emits nothing on a distance trigger, which is correct: their
last known point *is* their current point. Battery objection is further weakened
by the vertical — a driver on shift is on a car charger.

## Secondary benefit, and it's large

Background location resurrects the heartbeat. `last_seen_at` currently only
ticks while the app is foregrounded, which is the root cause of the entire
phantom/liveness saga (`project_driver_liveness_phantom_reaper`,
`project_driver_presence_rework`). With a background task running, a driver with
a pocketed, locked phone keeps heartbeating and stops being a phantom at all.

Consequence to re-decide AFTER the store build produces real data: the 4h reaper
and `preferLive()` ranking were both sized for a world where backgrounding looks
like death. Do NOT pre-emptively re-tighten them — the NULL-tolerance rollout
rule still applies, and a mixed fleet (some devices on the old build) is exactly
the population that tolerance protects.

## The sharp constraint: reaper window becomes tracking window

The reaper sits at 4h. That was safe *because* location was foreground-only: a
driver who forgets to toggle off and drives home emits nothing, the app isn't
running. Turn on background location and that same 4h becomes four hours of
following a person home from work.

So tracking needs its own stop, independent of the dispatch reaper. Two
separate stops, doing two different jobs:

- **(a) Stationary pause — battery, not privacy.** The distance trigger already
  does most of this for free. Nothing to build beyond not using a time trigger
  while idle.
- **(b) Shift auto-end — privacy.** After N minutes with no ride activity, push
  "Still on shift?". No acknowledgement within ~15 min → `is_active = false` and
  the location task stops entirely. A working driver taps once; a driver who
  forgot is bounded at N+15 min of exposure instead of 4h.

**N = 45 minutes** (decided 2026-09-10). A quiet night shift in Kentville
legitimately has no rides for 45 min, so the prompt WILL fire on working
drivers — accepted, because the cost of a false fire is one tap, and 45 is the
number a customer's privacy policy has to survive. Revisit with real shift data.

Note this is deliberately NOT a return to the aggressive auto-offline the
presence rework removed: that flipped drivers offline for being *quiet*; this
flips them offline only after an explicit un-answered prompt.

## Breadcrumb history — new table

Live position needs no schema (`drivers.current_lat/lng` already carries it;
background location just keeps it fresh). History does.

```
driver_locations
  id            bigserial pk
  driver_id     uuid  not null references drivers(id)
  company_id    uuid  not null           -- denormalised: every read is tenant-scoped
  ride_id       uuid  null               -- set when the fix was during a fare
  recorded_at   timestamptz not null     -- device clock at fix time, NOT insert time
  lat, lng      double precision not null
  heading       double precision null
  speed         double precision null
  accuracy      double precision null
```

Load-bearing details:

- **`recorded_at` is the device's fix time, not `now()`.** Batches arrive late
  (offline stretch, backgrounded upload); stamping on insert would draw a
  straight teleport line through a dead zone.
- **Batch the inserts.** The background task accumulates fixes and posts an
  array every ~60s. One insert per fix is a per-fix round trip on a mobile
  connection and would dominate the battery cost the cadence design just saved.
- **Index `(company_id, driver_id, recorded_at desc)`** — every read is
  "this driver, this window".
- **RLS**: company-scoped read for admins via `get_my_company_id()`; driver may
  read their own; passengers never. Insert is driver-own-row only, or via an
  Edge Function if the batch needs server-side validation.
- **GRANT statements in the same migration** (post-Oct-30-2026 rule).

### Retention is not optional

The DB is already creeping on the 2GB free tier. Rough volume: ~2,000 fixes per
driver-shift → 11 drivers ≈ 20k rows/day ≈ 600k rows/month. Survivable. A
300-car fleet (Casino Taxi scale) is ~22M rows/month, which is not — that tier
needs partitioning or downsampling before it is sold.

Ship with: nightly `cron.schedule` prune (same pattern as `cleanup-cron-logs`),
**30 days raw**. Optional later: downsample >30d to one fix per 60s and keep a
year for dispute evidence, which is the actual reason a taxi company wants
history.

## Native change — build & store implications

- `expo-location` background mode + `expo-task-manager` (new direct dep).
- iOS: `UIBackgroundModes: ["location"]`, `NSLocationAlwaysAndWhenInUseUsageDescription`.
- Android: foreground service with `foregroundServiceType: "location"`,
  `FOREGROUND_SERVICE_LOCATION`, likely `ACCESS_BACKGROUND_LOCATION`.
- iOS shows its blue indicator, Android a persistent notification. Both are
  user-visible and that is correct — it is the honest signal.
- Moves the fingerprint, needs a store build. **Batch with**: the unshipped
  `last_seen_at` heartbeat, `expo-keep-awake` as a direct dep (already in the
  tree under `expo/node_modules`, so no new native code — but not resolvable
  from app code until it is a direct dep), and any pending `extra` changes. The
  free-rotation window is already shut (see the Android maps key note), so
  everything native queues behind one build regardless.

**Play / App Store — ANSWERED 2026-09-10, verified against the installed
`expo-location@19.0.8` source, not from memory.**

*Android: we do NOT need `ACCESS_BACKGROUND_LOCATION`.* `LocationModule.kt:246`
carries the decision explicitly:

```kotlin
// 1. As a background location service, this requires the background location permission.
// 2. As a user-initiated foreground service with notification, this does NOT
//    require the background location permission.
if (!shouldUseForegroundService && isMissingBackgroundPermissions()) throw ...
```

Passing a `foregroundService` option to `startLocationUpdatesAsync` takes path
2. The config plugin supports this cleanly: `isAndroidForegroundServiceEnabled`
is a SEPARATE flag from `isAndroidBackgroundLocationEnabled`, and only the
latter adds `ACCESS_BACKGROUND_LOCATION` to the manifest. So set
`isAndroidForegroundServiceEnabled: true` and leave the background flag OFF —
which skips the strict background-location declaration form entirely.

*But a declaration does not vanish, it gets lighter.* Targeting Android 14+,
any `FOREGROUND_SERVICE_LOCATION` type must be declared in Play Console (Policy
> App content) with a description and a demo video showing the user-initiated,
perceptible action behind it. That video is the go-online toggle plus the
persistent notification — a 30-second recording, and the recording rig from
`project_demo_videos` already exists.

*Dated policy change to calendar:* Play's Minimum Scope policy makes an
`ACCESS_FINE_LOCATION` declaration available Nov 2026 and **mandatory
2027-01-27**. Our justification is core functionality (dispatch to nearest
driver + passenger ETA), which is the strong case, but it is a deadline that
lands during the first customers' first year.

*iOS: When-In-Use is enough, no "Always" prompt.* `LocationModule.swift:165`
only calls `ensureForegroundLocationPermissions` plus a check that
`UIBackgroundModes` contains `location`. So set
`isIosBackgroundLocationEnabled: true` (which adds the background mode) and
request only foreground permission. The blue status bar shows — correct and
honest.

**The hard constraint this creates, and it belongs in the sales copy.** The
Android FGS can only be STARTED while the app is foregrounded
(`ForegroundServiceStartNotAllowedException`, `LocationModule.kt:258`). So
tracking cannot be resumed remotely, by push, or after a reboot or a
swipe-kill: the driver must open the app. That is the honest ceiling versus
hardwired GPS hardware, and it matches how Victor already frames it — trackers
as a secondary layer for tamper-resistance, the app for everyday visibility.
Do not pitch this as tamper-proof; it is not, and a taxi owner will find out.

**App Store review is probably NOT a cost here.** The earlier note called
all-shift "harder to argue"; the discriminator reviewers actually key on is
whether tracking is bound to an explicit, user-initiated on-shift state. The
`is_active` toggle is exactly that, and driver-toggled background location is
the standard driver-app pattern. Confirm against current guidance rather than
paying for it in the design.

## Consent chain

Vellon is the vendor; the **taxi company is the employer**, and theirs is the
relationship that makes on-shift tracking legitimate. Three artefacts, none of
which block the technical design:

1. In-app driver disclosure at first go-online after the update — what is
   tracked, when it starts, when it stops, who sees it. Must precede the OS
   permission prompt (Play's "prominent disclosure" requires this ordering).
2. MSA language making the company the data controller and Vellon the
   processor.
3. Privacy policy covering retention.

Tracked under `project_legal_compliance_prelaunch`.

## Build order

1. Native config + `expo-task-manager` + tiered `startLocationUpdatesAsync`,
   writing `drivers.current_*` and `last_seen_at` as the existing 10s interval
   does today. **Live tracking works at this point.**
2. `driver_locations` migration + batched upload + nightly prune cron.
3. Shift auto-end prompt (the privacy stop).
4. Dashboard: replay view — pick a driver + a day, draw the path, mark idle
   dwell time. This is the half that actually reads as "a GPS tracker".
5. Store build, batching everything native pending.

Steps 1-4 are all shippable behind the same single store build; only step 1 is
native.


## Step 1 — built 2026-09-10

`expo-task-manager@~14.0.9` added as a direct dep. New `src/lib/driverLocation.ts`
owns the task; `useDriverLocationBroadcast` starts/stops it; `App.tsx` imports it
for its side effect.

**Verified with `expo config --type introspect`** (does NOT generate `android/`,
which per the fingerprint note would flip workflow detection):

```
ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION,
FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION
ACCESS_BACKGROUND_LOCATION present: false      ← the whole point
iOS UIBackgroundModes: ["fetch","location"]
```

### The two-writer split, and why it is not an accident

The old 10s `setInterval` did two jobs at once: it wrote position AND it beat
`last_seen_at`. Collapsing both into a distance-triggered background task would
have reintroduced the phantom — a driver parked at the stand for 40 minutes
correctly emits no distance fixes, so their liveness would rot while they sit in
plain sight on the dispatch map. That is the exact failure this change was
partly meant to FIX, arriving through the back door.

So they are separate writers now:

- **background task** — WHERE they are. Distance-triggered idle (150m /
  Balanced), time-triggered during a fare (8s / 25m / High). Survives
  backgrounding.
- **foreground interval** — WHETHER they are there. A pure `last_seen_at` touch
  that takes no GPS fix at all while the task is running (`isDriverLocationRunning()`
  gates it), and falls back to fixing position itself if the task failed to
  start.

Both go through `writeDriverPosition()` so they cannot drift on which columns a
position update touches, and both keep the `device_token` compare-and-set — the
displacement detector. The task additionally **stops itself** on a displaced
write: a device that lost the session lock must not keep writing position, or
dispatch sees two cars for one driver.

### SEQUENCING GATE — do not cut a store build on step 1 alone

Step 1 turns on whole-shift background tracking whose ONLY stop is the 4h
reaper. That is exactly the drive-home exposure this design named as its sharp
constraint. **No store build until the 45-min shift auto-end (step 3) ships** —
otherwise the privacy behaviour reaching a customer's drivers is not the one
described above, and it is the kind of thing that gets swept in on "cut the
build, everything else is ready" (the heartbeat build has been pending for
weeks).

### Known gaps, accepted for step 1

- **iOS backgrounded AND stationary stops beating** (JS timers are suspended;
  Android keeps beating on the FGS `timeInterval`). Dispatch RANKS on liveness
  rather than filtering and the reaper is at 4h, so the cost is offer priority,
  not a missed ride. The alternative — iOS `distanceInterval: 0` with an in-task
  throttle — was rejected: ~1Hz delivery burned through a throttle is exactly
  the battery profile the tiered cadence exists to avoid. If this matters after
  real shift data, the cheaper fix is teaching `presence.ts` that "same
  coordinates, not moving" ≠ "stale", not fighting the platform.
- ~~**Session expiry inside the task.**~~ **NOT a gap — this is the step-1 bug,
  see "The absorbing session bail" below.** The entry was wrong twice over:
  `resolveDriverId()` does NOT refresh (it bails and says so in its own warn
  string), and the bail is silent rather than loud — `console.warn` in a
  headless context nobody is attached to. Worse, the premise that "a dropped fix
  costs nothing: the next one covers it" is false, because the condition never
  heals while backgrounded.
- **Idle `timeInterval` is 30s, not 60s.** `presence.ts` in both repos calls a
  driver stale at exactly `PRESENCE_STALE_MS = 60_000`, and the dashboard
  renders its online/away pill straight off it — a 60s beat would sit on the
  boundary and flicker for a parked driver, on the very surface being sold as
  "know where your drivers are".
- **`killServiceOnDestroy: false` — verified, not assumed.**
  `LocationTaskService.kt:54` only calls `stop()` from `onTaskRemoved` when the
  flag is true, so the service survives the app being swiped out of recents. It
  does NOT survive a force-stop from Settings, or a reboot.
- ~~**Not yet observed on a device.**~~ **OBSERVED 2026-09-10** on the iOS
  `preview` build. The permission prompt reads **"While Using the App"**, as
  `LocationModule.swift:165` predicted. Fixes land while the phone is locked,
  `ride_id` is attributed, and `received_at` lags `recorded_at` by up to 29 min
  with the device fix time intact — so the batching and the two-timestamp design
  both do what they claim. See "Locked-and-stationary" below for the one defect
  the run surfaced.


## `active_ride_eta_seconds` — CLOSED 2026-09-10

The car moved while backgrounded but the countdown beside it did not, which
reads worse than a frozen car: the two visibly disagree. Fixed by moving the
route maths to `src/lib/routeProgress.ts` and having `DriverActiveRideScreen`
stash its decoded polyline + average speed for the task, which recomputes the
same number from the same geometry on every fix. Storing the route rather than
calling Directions from the task is what keeps it free — a Maps call per fix is
the bill local interpolation exists to avoid.

Off the stored route, the task writes **NULL, not the last number**. It cannot
reroute, and a confidently wrong countdown is the same bug wearing a costume;
the passenger UI renders no ETA instead. Guards on route age (45 min) and on the
route belonging to this ride.

## Step 2 — built 2026-09-10

Migration `20260768_driver_locations.sql` + `src/lib/breadcrumbs.ts` + the task
recording every fix in a delivered batch.

**APPLIED AND VERIFIED 2026-09-10** (20260768 + 20260769, all 8 checks green:
3 policies, RLS on, `authenticated` = INSERT + SELECT only with anon holding
nothing, prune function service-role only, cron active). Check 4 FAILED on the
first pass — see 20260769 — which is the reason to run these at all: the
migration read as correct and its comment asserted a guarantee that was not
live. Re-run
`.claude/notes/driver-locations-postapply-checks.sql` after any change here. A client hitting a missing table gets a permanent PostgREST error, and per
the uploader's error branching that batch is dropped — silent history loss with
a working live dot, which is the failure mode hardest to notice.

Design points that are load-bearing:

- **`recorded_at` (device fix time) AND `received_at` (insert time).** One extra
  column makes a wrong device clock distinguishable from a genuine upload delay,
  which matters when the history is evidence.
- **No UPDATE or DELETE grant to anyone.** A breadcrumb is an immutable
  observation; a driver able to edit their own trail removes the reason a
  company trusts it.
- **Passengers get nothing.** Live position during their own ride is the entire
  legitimate need; history would let anyone who ever booked reconstruct a
  driver's movements.
- **Fixes are buffered (10 fixes or 60s, whichever first), capped at 450 with
  the OLDEST dropped**, persisted in AsyncStorage so a killed JS context does
  not lose them, and serialised through a promise chain because the task can
  fire again mid-flush and the buffer is a read-modify-write.
- **The flush distinguishes transient from permanent failures.** Retrying
  everything forever is a silent stall: `status === 0` (PostgREST resolves,
  never throws, on a network failure) or 5xx keeps the rows; a 4xx drops the
  batch loudly. The concrete permanent case is `ride_id` — it is persisted to
  survive a headless relaunch, so it also survives a crash mid-ride, and a
  deleted ride fails the FK (23503) on every retry forever.
- **The company-id cache is keyed by driver id.** A shared phone would otherwise
  inherit the previous driver's company, fail the INSERT policy's company check
  on every row, and retry the same rejected batch forever.


## Step 3 — built 2026-09-10

`20260770_shift_auto_end.sql` + a block in `scheduled-coverage-monitor` +
`SHIFT_CHECK` notification actions. 45 min idle -> ask, 15 more -> offline,
which stops the device's location task through the existing realtime
`is_active` subscription.

- **"Idle" is not "no ride events".** A driver two hours into a Halifax run has
  no status transitions for the whole fare, and a driver on street hails has
  none at all — a ride-event-only test switches both off mid-fare. Movement
  comes from `driver_locations` via `driver_has_moved()`, as a **bounding box**
  rather than "did rows arrive", because the fallback heartbeat files a fix
  every 10s whether the car moved or not. (That fallback now also skips crumbs
  under 50m.)
- **Prompt and end are separate statements**, and the end branch requires an
  outstanding prompt older than the grace window. One combined UPDATE races
  itself: a driver 60 min idle with no prompt satisfies both branches on the
  same tick and statement order decides. The split is what makes "nobody is
  ended without being asked" true rather than usually-true.
- **A RECOVER statement runs first**, clearing the prompt for anyone who turned
  out to be working. Without it `shift_prompt_at` stays set forever and, since
  PROMPT requires NULL, they could never be asked again.
- **Both notification buttons open the app.** The ack must be written by a
  mounted handler; a background action fires where `DriverApp` may not exist.
- Both new functions are service-role only, revoked from `anon`/`authenticated`
  **by name** — otherwise the app's anon key could switch every driver on the
  platform offline.

Checks: `.claude/notes/shift-auto-end-postapply-checks.sql`. Check 5 is a dry
run inside a transaction you roll back.


## Step 3 follow-ups — what the dry run caught (20260771)

Running check 5 BEFORE deploying is the only reason these were not found in
production, and both were invisible in code review.

- **Six drivers due to be prompted, all with `push_token = NULL`.** The prompt
  had nowhere to go, so they would have sat out the grace window in silence and
  been "ended for not answering" a question that could not be delivered. Fixed
  by ending them directly, with no prompt and no grace window (a grace period
  only means something to someone who was asked), reported as
  `ended_unreachable` so no log line claims otherwise. Sparing them was the
  wrong answer: `assign-ride` filters on `push_token` because a ride offer IS a
  push, so unreachable + not moving is not a working shift, and leaving them
  alone means background location running indefinitely for someone who revoked
  notifications — the exact exposure step 3 closes.
- **They were the seeded demo drivers**, which would have gone offline within
  the hour and vanished from the dispatch map, possibly mid-pitch. They had been
  surviving on an ACCIDENT: `presence.ts` treating `last_seen_at IS NULL` as
  live, a tolerance that exists for an unrelated reason (builds predating the
  heartbeat during a non-atomic rollout). `drivers.is_demo` now says what is
  meant; both `run_shift_auto_end` and `reap_stale_drivers` skip it, so it
  survives the day that NULL tolerance is tightened. **The UPDATE that sets the
  flag is deliberately not in the migration** — flagging a real driver opts them
  out of every automatic offline sweep, silently and permanently.


## Step 4 — built 2026-09-10 (mgcj-dashboard `49bf18b`)

Drivers tab -> driver -> "View this driver's trail". Reuses the always-mounted
map (the detail panel steps aside); trail logic is pure, in
`mgcj-dashboard/src/lib/trail.ts`.

The rules are judgement calls, not drawing, which is why they live away from the
map code:

- **A gap over 6 min breaks the line.** A gap means parked, a tunnel, a dead
  zone, or a closed app — in none of those do we know the car went straight.
  Joining across it invents a route, which a record used as evidence must never
  do.
- **Movement under 15m is jitter.** A parked car wanders metres per reading;
  over a shift that sums to kilometres never driven, on a number a driver would
  dispute.
- **Stops anchor on the first fix of a run, not a rolling centroid** — a rolling
  anchor lets a slow crawl through traffic drift across town while every step
  stays "near" the last, reporting a two-mile shuffle as one stop.
- **Orange = on a fare, grey = between**, because "was the meter running while
  you drove that way" is what a dispute turns on.
- **The scrub marker goes hollow** when the nearest fix is far from the scrubbed
  time: that is the last known position, not where the car was.
- Live driver/ride markers are REMOVED while a trail is open and their renderers
  no-op — `fetchRides` recreates them wholesale and the 15s poll would otherwise
  put today's pins back over Tuesday's trail mid-session.
- Scrubbing has its own effect and its own overlay; a range input fires
  continuously while dragged, and rebuilding every polyline per pixel stutters.

**Untestable by eye until step 5** — no device runs the background task yet, so
every real driver has zero fixes and the view is empty for all of them. The
empty state says so explicitly. `.claude/notes/driver-trail-seed-and-verify.sql`
seeds a plausible shift for a DEMO driver (Kentville -> New Minas -> 25-min stop
-> Wolfville, one leg on a fare) so the view can be exercised and — more
importantly — so the staff RLS path is proven: with no company filter in the
query, a policy that does not grant returns `data: []` and no error, which
renders identically to "this driver was offline".


## Locked-and-stationary: the dot faints mid-fare — OPEN 2026-09-10

Observed on the first device run: with the phone locked for a while, position
stops updating and the dashboard's driver indicator goes "away". Face-ID
unlocking corrects it to the true position immediately.

**Do not diagnose this from `driver_locations`.** Every long gap in the first
run's data is benign idle-tier buffering (29 min and 11 min, both `ride_id`
NULL, both explained by the no-independent-flush-timer behaviour below), and
every in-ride cluster shows fixes landing every 7-20s *while locked*. The
frozen window was never captured — all observation so far happened after the
unlock that ends it.

Three candidates, and they need different fixes:

1. **Nothing was delivered.** iOS ride tier is `distanceInterval: 25` alone
   (`timeInterval` is Android-only), so a stationary car emits nothing, and the
   foreground `setInterval` that would otherwise beat `last_seen_at` is
   suspended while locked. Position was never wrong; only the presence
   *interpretation* is. Fix lives in `presence.ts` — "same coordinates, not
   moving" is not "stale".
2. **Session bail.** `resolveDriverId()` returns null when the token has under
   60s of life, and the task `return`s before `recordFixes`. Writes stop
   silently; the foreground refresh on unlock resumes them.
3. **iOS throttling repeated headless JS relaunches** after sustained lock.
   Matches "works for a while, then stops" as well as (2) does, and cannot be
   fixed in JS at all — the beat would have to ride on CL delivery.

**The obvious discriminator does not work.** Because the task returns before
`recordFixes` (`driverLocation.ts:222`), a session bail and a task that never
fired leave *identical* evidence: no crumbs and no `drivers` write. Separating
them needs a capture taken WHILE the dot is faint:

```sql
select last_seen_at, updated_at, current_lat, current_lng from drivers where id = '<id>';
select max(recorded_at), max(received_at) from driver_locations where driver_id = '<id>';
```

Crumbs newer than `last_seen_at` → the `drivers` write is failing specifically.
Neither advancing → nothing was delivered. `idevicesyslog` (libimobiledevice,
works on Arch over USB) catches the `[Location] session expiring` warn and
settles (2) vs (3) directly.

**Blocking status forks on the answer.** (2) or (3) = position loss during a
fare, which blocks the store build. (1) = does not block the build, but does
block the "know where your drivers are" claim.

**The known-gap entry above mis-scored this.** It reasoned the cost is "offer
priority, not a missed ride" — true for an IDLE driver. A driver mid-fare is
not in the offer pool at all, so ranking is irrelevant and the entire cost
lands on the dispatch map, which is the surface being sold.

## Two smaller things the same run surfaced

- **No independent flush timer.** `flushRows` is reached only when a new fix
  arrives (`breadcrumbs.ts:145`) or on go-offline (`driverLocation.ts:338`).
  Confirmed live: a fix at 23:18:32 was not posted until 23:47:59, when the
  next one arrived. Harmless for history (the buffer persists, nothing is
  lost) but it means a driver's last leg can sit unposted for a long time, and
  it **distorts diagnosis of this very feature**: `max(recorded_at)` cannot see
  the buffer, so "no crumb at time T" does not mean "no fix was delivered at
  time T". Any test that reads the table must force a flush first — go offline,
  which calls `flushBreadcrumbs` unconditionally — or it is measuring the
  flush trigger rather than the location task.
- **GPS jitter trips the 25m ride filter.** Ride 1, 23:50:15-23:51:18: longitude
  oscillates back and forth across ~37m with no trend, generating 4 fixes from
  a car that did not move. `trail.ts` calls movement under **15m** jitter, so
  the replay view will draw a visible scribble for a parked car — raise that
  threshold or smooth before step 4 is shown to a customer. `driver_has_moved()`
  is NOT affected: its bounding box is ~0.002 degrees (~200m), comfortably
  wider than the noise, so the shift auto-end prompt is not defeated by it.


## The locked-phone blackout — ROOT CAUSE FOUND 2026-09-11 (the keychain)

**Everything in this section below the next heading is superseded — both candidates
were wrong. Kept for the reasoning trail. Read "The keychain is the answer" first.**

Supersedes the "Locked-and-stationary" section's cause (1). That reading was
wrong and the test that killed it was: **20 minutes of walking outdoors, blue
indicator present, zero fixes recorded.** At a 25m filter that is ~60 fixes
missing, six times the flush threshold. Nothing about being stationary explains
it.

Mechanism, all three parts verified in source:

1. `supabase.ts:132` calls `stopAutoRefresh()` on background. Correct and
   deliberate — it exists because of the 2026-08-13 `create-payment-intent` 401.
2. The access token expires (Supabase default 1h). Corroborated by the timing:
   the last successful write was **00:29:27** and nothing followed it.
3. `resolveDriverId()` compares `expires_at` and returns null within 60s of
   expiry — and the task `return`s before `recordFixes`, so **both** the
   breadcrumb and the `drivers` write are lost, not just the live position.

**Why this is not "a dropped fix".** The bail's own comment argues "A dropped
fix costs nothing: the next one, or the foreground interval, covers it." Both
escapes are unavailable in the state that triggers it. Nothing refreshes the
token while backgrounded, so every subsequent fix bails identically — the
condition is **absorbing, not transient**. And the foreground interval only
"covers it" while foregrounded, which is precisely the state where the bug does
not exist. Unlocking the phone restarts the refresh loop and everything corrects
at once, which is exactly what the driver sees and why it reads as a display
glitch rather than data loss.

**Cost:** a driver who locks their phone loses live position, `last_seen_at`,
AND the whole breadcrumb trail from token expiry until they next unlock. On the
sales claim this feature exists for, that is the entire product.

### CORRECTION — the bail is probably unreachable, so it is not the root cause

Written before checking `getSession()` itself. `__loadSession` refreshes when the
token is within **`EXPIRY_MARGIN_MS` = 90s** of expiry
(`AUTO_REFRESH_TICK_THRESHOLD` 3 x `AUTO_REFRESH_TICK_DURATION_MS` 30s), and
`stopAutoRefresh()` only stops the periodic *timer* — it does not stop
`getSession()` from refreshing on demand. `resolveDriverId()` bails under
**60s**. 90 > 60, so any token old enough to trip our check has already been
refreshed by the `getSession()` call on the line above it, and `expires_at` is
an hour out by the time we compare it.

So the bail can only fire when **the refresh itself failed**. The three points
of mechanism above are still individually true; the conclusion drawn from them
was not. Two candidates remain and they need different fixes:

- **(a) Refresh failing while backgrounded.** `timeoutFetch` aborts at 20s
  (`timeoutFetch.ts:66`), and `REFRESH_FAILURE_COOLDOWN_MS` is 60s, so a
  throttled background network could fail and then cool down repeatedly.
- **(b) The task's JS never runs.** The blue indicator proves iOS holds an
  active location session, NOT that our callback executes. If iOS is declining
  to relaunch the JS context, every write is absent for a reason no amount of
  auth work touches.

**Decisive evidence is the device log**, because the two are indistinguishable
from the database: `[Location] session expiring` / `no session in task context`
present = (a); no task log lines at all across a walk = (b). Do not write code
against either until that log exists. Diagnosis has already been wrong twice
here, both times from reading one layer and not the one under it.

### The stated reason for bailing does not survive checking

The comment fears a rotation race: the task refreshes, then `startAutoRefresh()`
fires on resume holding the refresh token it read *before*. Checked against the
installed `@supabase/auth-js`:

- `_autoRefreshTokenTick()` wraps its work in `_useSession()`, which re-reads
  the session rather than closing over an earlier one — so the resume tick picks
  up whatever the task rotated to.
- `_callRefreshToken` single-flights via `refreshingDeferred`
  (`GoTrueClient.js:4063`), so concurrent callers share one in-flight refresh.
- Note `this.lock = null` by default (`GoTrueClient.js:141`) — there is no
  implicit `processLock` in RN. Cross-*process* safety is genuinely absent; the
  task and the app share one process, so `refreshingDeferred` covers our case.

That weakens the fear considerably but does not make an auth change free — the
scars behind it (`onauthstatechange-callback-deadlock`,
`project_signout_scope_session_bug`) are real and were expensive.

### Two candidate fixes, deliberately separable

**(A) Buffer the crumb BEFORE the session check.** `recordFixes` needs only a
driver id, which can be persisted exactly as `ACTIVE_RIDE_KEY` already is, and
the buffer already survives a headless relaunch. The batch then flushes on the
next successful write. Recovers the full trail across the locked window and
touches no auth code at all. Does NOT fix live position or `last_seen_at`.

**(B) Refresh inside the task.** Fixes all three symptoms, and is the only thing
that keeps the dispatch map and the passenger's car live while the phone is
locked. Costs an auth change in a file with a bad history; `processLock` from
`@supabase/auth-js` is the belt-and-braces companion.

They compose: (A) is the cheap, safe half and makes the history claim true even
if (B) is deferred. Do not let (A) shipping alone be mistaken for the bug being
closed — the live dot still dies.

### Also re-price

- The same expiry is what produced the 2026-08-13 `create-payment-intent` 401
  described in `supabase.ts`'s own comment. Any other path that reads
  `session.access_token` and builds its own fetch has this bug too.
- Supabase's access-token TTL is configurable. Raising it is a mitigation to
  price alongside, never instead — it moves the cliff, it does not remove it.

### Diagnostic + candidate fixes shipped by OTA 2026-09-10

One `eas update` to `preview` carrying all four, because the outcome is
conclusive whichever candidate is true:

1. **A — buffer before the auth check.** `recordFixes` now runs before the
   session is resolved, using the driver id off the stored session
   (`getSession()` reads from storage, so it is available with a dead token and
   needs no network). A new `allowFlush` argument buffers without attempting a
   round trip when the token is known-unusable. History now survives a locked
   window regardless of auth.
2. **B — refresh instead of bail.** `resolveDriverId()` became
   `loadTaskSession()`, which retries the refresh explicitly and RECORDS the
   failure reason. Since the old bail was only reachable when `getSession()`'s
   own refresh had already failed, the reason is the interesting part.
3. **The 4xx drop bug.** `flushRows` treated any 4xx as permanent and cleared
   the buffer — so an expired-token 401 destroyed exactly the history (A) exists
   to protect. 401/403 are now retained.
4. **The diary** (`src/lib/taskDiary.ts`, temporary). AsyncStorage only: no
   console, no session, no network, because all three are suspect. Surfaced
   read-only under driver Help & Support -> "Location diagnostics".

**How to read the result of the next locked walk:**

| diary after the walk | means |
|---|---|
| entries, `session unusable — refresh failed: …` | candidate (a); the message names the cause |
| entries, `session ok` + `position write ok` | fixed by (B); confirm rows in `driver_locations` |
| **empty across the whole window** | candidate (b) — iOS never ran the JS. No auth work can fix it. |

The empty case is the one worth designing the test around: it is the only
outcome that invalidates both fixes, and it is invisible in the database because
it looks identical to everything else.

Typecheck: 333 errors before and after, all pre-existing and in other files.


## The keychain is the answer — 2026-09-11

`expo-secure-store` defaults to **`WHEN_UNLOCKED`**, so the keychain item is
unreadable while the phone is locked. `supabase.auth.getSession()` reads the
session through `ExpoSecureStoreAdapter`, so in the background task it **stalls**
— does not throw, stalls — for as long as the device stays locked.

### The evidence, and why it is decisive

A 17-minute locked walk produced ~60 diary entries of exactly this shape:

```
1:09:26  task entered - 1 fixes      <- and nothing after it
...      (every ~19s, 60 times)
1:26:28  task entered - 1 fixes
1:29:15  task entered - 1 fixes
1:29:15  session ok - 2115s left     <- resumes the instant the phone is unlocked
```

Two independent proofs sit inside that data:

1. **The control is in the same invocation.** The diary writes to AsyncStorage
   (no keychain protection) and worked throughout; the session read is
   SecureStore and never returned. Same task, same fixes, microseconds apart.
2. **The token never expired.** `1:04:38 + 3593s = 2:04:31` and
   `1:29:15 + 2115s = 2:04:30` — the same expiry, so no refresh happened and
   none was needed. It had ~40 minutes of life for the whole walk.

Both earlier candidates are dead: the task DID run (60 times), and expiry was
never in play.

### Two things this means about the previous fix

- **Fix B (refresh in the task) addressed a problem that did not exist.** It is
  harmless and defensively reasonable, but nothing is fixed because of it. Do
  not read its presence as the cure.
- **Fix A was in the wrong place, and the reason is worth keeping.** The buffer
  went after `loadTaskSession()` and before the *usability* check — but the
  stall is in the session load itself, so `recordFixes` was never reached and a
  whole walk of history was still lost. The rejected advice (persist the driver
  id like `ACTIVE_RIDE_KEY`) was right; the counter-argument — "getSession reads
  from storage, so the id is available even with a dead token" — was true about
  the token and wrong about *which* storage and whether it is readable while
  locked.

### The fix (shipped by OTA 2026-09-11 — JS only, `keychainAccessible` is a
runtime option, no rebuild)

1. **`AFTER_FIRST_UNLOCK` on every SecureStore write**, via
   `src/lib/secureStoreAccess.ts`. Still encrypted at rest, still unreadable
   until the first unlock after boot; readable across later locks. Standard for
   apps with background work — **do not harden it back** without first moving
   everything off the background path.
2. **Migration on first read.** Accessibility is a property of the stored item,
   fixed at write time, so an existing session keeps `WHEN_UNLOCKED` until
   rewritten. `readAndMigrate()` rewrites once per key per process — no key
   list, no migration flag, no forced sign-out.
3. **`deviceSession.ts` too, not just the session.** `writeDriverPosition()`
   calls `getDeviceToken()` FIRST, and that is also SecureStore — fixing only
   the session would have moved the stall one line down and looked like a
   different bug.
4. **Crumbs buffer before anything touches the keychain**, keyed off a new
   AsyncStorage `driver.location.driverId`. This is the belt: it keeps history
   whole the next time something in that context stalls, whatever it is.
5. **`withTimeout` (8s) on the session load**, so a stall costs one invocation
   instead of hanging it forever — 60 pending promises was the old behaviour.

### How to read the next walk

The diary must show **`crumbs buffered` BEFORE the session line**. If the walk
comes back clean, that ordering is the only thing proving the belt works rather
than the keychain fix alone having made it moot — assert it separately, because
a clean outcome hides which of the two produced it.

### Walk 2 (2026-09-11, ~1:45-2:03) — belt PASSES, keychain fix did NOT take

`crumbs buffered - 1` on **every one** of ~50 invocations across the locked
window. Under the previous build all of those were lost. **History is now whole
through a locked walk**, which is the claim this feature is sold on. Asserting
it separately was worth it: the keychain half failed, and a single pass/fail
would have hidden that the belt is what held.

Still no `session ok` / `session unusable` between 1:46:20 and 2:02:51, so the
session load still stalls.

**Why the accessibility fix did nothing — native, verified in source.**
`SecureStoreModule.swift:112` calls `SecItemAdd`; on an existing key that
returns `errSecDuplicateItem` and falls through to `update()`, whose update
dictionary is `[kSecValueData: valueData]` — the value ONLY
(`SecureStoreModule.swift:126-137`). **`kSecAttrAccessible` is never part of an
update**, so rewriting an existing item cannot change its accessibility, and no
amount of ordinary session refreshing heals it. `readAndMigrate` now
**deletes before re-adding** so the write reaches the `SecItemAdd` path.

**The 8s `withTimeout` never fired either**, and that is its own lesson:
`setTimeout` needs the JS runloop, which iOS suspends between task invocations.
A timer cannot guard anything in this context — note `timeoutFetch`'s 20s abort
is built the same way and is therefore equally inert here, which matters because
it is the app's only protection against a hung auth request.

**Probe added** (`probeAuthKeyRead`): reads the session key directly, before
`getSession()`. Next walk is self-diagnosing —

| diary | meaning |
|---|---|
| no `ss probe` line | the keychain is still blocking; the migration did not take |
| `ss probe` then no `session` line | keychain is fine, `getSession` hangs elsewhere (likely a network call inside `_initialize`) |
| `ss probe` + `session ok` + `position write ok` | fixed |

### Walk 3 (2026-09-11, 2:19-2:33) — FIXED

38 consecutive invocations over 14 minutes, every one the full chain:

```
task entered - 1 fixes
crumbs buffered - 1
ss probe - hit 2016b      <- keychain readable WHILE LOCKED
session ok - 3419s left
position write - ok
```

Delete-before-add was the missing piece; `SecItemUpdate` never carrying
`kSecAttrAccessible` is the whole reason the previous attempt looked like a
failed hypothesis rather than a failed write. Live position, heartbeat and ETA
now all survive a locked phone.

Two things to note from the same data:

- **One `position write - skipped` at 2:20:50**, 4s after its task entry, then
  clean for the remaining 37. `writeDriverPosition` returns `"skipped"` for TWO
  different causes — no device token, or the UPDATE erroring — so this is
  ambiguous by construction. One in 38 with a 4-second delay reads as a
  transient network error; worth splitting the return value if it recurs.
- **`ss probe - hit 2016b`** matches the 2014-byte measurement in the
  SecureStore A2 note, i.e. ~32 bytes of headroom under the 2048 soft limit.
  Unchanged risk, but the number is now confirmed from a second direction.

### Duplicate breadcrumbs — introduced and fixed same day

The belt buffered the batch, and the ORIGINAL `recordFixes` call was left in
place below it to trigger the flush — so it re-appended the same fixes and every
point landed **twice**. Present in walks 2 and 3.

Fixed with `flushIfDue(driverId)` in `breadcrumbs.ts`: applies the same
count/age rule as `recordFixes` without appending. The rule is now explicit —
**buffer once, before auth; flush after auth; never re-record.**

Rows already written need a one-off dedupe (see below). `trail.ts` would have
drawn them as zero-length segments, which its 15m jitter floor mostly hides —
so this was heading for a silently doubled row count rather than a visible bug.

## Foregrounding counts as work — added 2026-09-12 (client-only, ships by OTA)

`run_shift_auto_end` recognised three signs of work: going online (trigger on
`drivers`), a ride changing status (trigger on `rides`), and movement
(`driver_has_moved` over `driver_locations`). Having the app open was invisible
to all three.

So a driver parked at a stand on a quiet night — phone in hand, app on screen,
no fare, not moving — is asked "still on shift?" after 45 minutes. That is the
shift where the question is least warranted, and `shouldShowAlert: true` means
it banners over the foregrounded app rather than being suppressed.

Fourth signal added in `useDriverLocationBroadcast`: an `AppState` listener that
stamps `shift_activity_at` on the transition to `active`, gated on `isOnline`.

Four decisions in it, each of which the obvious alternative gets wrong:

- **It must NOT ride on the heartbeat.** The heartbeat also runs from the
  background task while the phone is locked, so stamping there would let a
  driver who pocketed their phone and drove home prove they are working
  indefinitely — destroying the privacy stop step 3 exists to provide. Only an
  explicit human act may count, and a screen lock takes `AppState` out of
  `active`, so a forgotten phone cannot fake one.
- **It is NOT stamped on mount.** `isOnline` starts false and flips true when
  the fetch or realtime UPDATE lands, and `DriverApp` remounts this hook when it
  switches driver screens — "mounted" happens repeatedly with no human involved,
  which is precisely the property that makes foreground trustworthy.
- **It is NOT throttled.** Every `drivers` write is a WAL record fanned out to
  every open dispatch tab, so rate-limiting is the instinct — but a per-mount
  ref resets on those same remounts (see `monotonic-signal-vs-remounting-consumer`),
  and persisting a timestamp costs an AsyncStorage read on every resume to save
  a write we rarely make. The 20s heartbeat already dwarfs it.
- **It stamps activity only, and does not clear `shift_prompt_at`.** Safe
  because `run_shift_auto_end`'s RECOVER pass (clears the prompt for anyone with
  recent activity) runs BEFORE the END pass, and END requires a non-null prompt.
  A driver who opens the app during the 15-minute grace is withdrawn, not ended.
  **Verified live 2026-09-12**, not just read off the migration: against
  `pg_get_functiondef('public.run_shift_auto_end(int,int)'::regprocedure)`,
  RECOVER sits at byte 271 and END at 1328. The same query confirmed the live
  function is the `20260771` version (`ended_unreachable` present, so tokenless
  drivers are ended directly rather than "for not answering") and that the
  `is_demo` guard is in place.

Untouched: `is_demo` drivers are excluded from prompts entirely, and the write
goes through the existing `drivers: update own` policy — the same path the
prompt acknowledgement in `DriverApp` already uses, so no new RLS surface.
