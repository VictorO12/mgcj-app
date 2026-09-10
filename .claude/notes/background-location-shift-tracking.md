# Background location — whole-shift tracking + breadcrumb history

Status: STEPS 1-2 BUILT 2026-09-10. Migration 20260768 NOT yet applied, and
nothing is on a device — this is native code, so it needs the store build.
Steps 3-5 still design. Decided 2026-09-10. Supersedes the "active rides
only" section of `liveness-rework-design.md`, which is now wrong on one axis.

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
- **Session expiry inside the task.** `supabase.ts` stops the auto-refresh loop
  on background, so a batch arriving after hours has an expired access token and
  the `drivers` UPDATE policy is `id = auth.uid()`. `resolveDriverId()` refreshes
  when under 60s of life remains and bails loudly rather than writing on a dead
  token — a silent 401 in a context with no UI would be invisible.
- **Idle `timeInterval` is 30s, not 60s.** `presence.ts` in both repos calls a
  driver stale at exactly `PRESENCE_STALE_MS = 60_000`, and the dashboard
  renders its online/away pill straight off it — a 60s beat would sit on the
  boundary and flicker for a parked driver, on the very surface being sold as
  "know where your drivers are".
- **`killServiceOnDestroy: false` — verified, not assumed.**
  `LocationTaskService.kt:54` only calls `stop()` from `onTaskRemoved` when the
  flag is true, so the service survives the app being swiped out of recents. It
  does NOT survive a force-stop from Settings, or a reboot.
- **Not yet observed on a device.** `expo-task-manager` is native, so this does
  nothing in Expo Go. It is verified by introspection and typecheck only until
  the store build.


## Open item — `active_ride_eta_seconds` is still foreground-only

Deliberately NOT folded into step 2 (it is not a breadcrumb problem and would
have doubled the change). `DriverActiveRideScreen` computes the ETA from its own
`watchPositionAsync` and route progress, so during a BACKGROUNDED fare the
passenger's car now moves but the countdown still freezes — half of the original
bug remains. Whoever picks this up: the background task is already the position
authority during a ride, so the ETA either moves into it (needs the route
geometry, which lives in the screen) or the passenger client derives ETA from
the moving dot. Decide which before writing anything.

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
