# Driver liveness rework — from a binary filter to tiers

Status: DESIGNED, not built. Live state VERIFIED 2026-08-30 via
`liveness-rework-preapply-checks.sql`:

- The deployed `reap_stale_drivers` is byte-for-byte the migration: default
  `stale_minutes = 5`, nulls `current_lat/lng`, skips active-ride drivers.
  EXECUTE is service_role + postgres (owner) only — no anon/authenticated/PUBLIC.
- **11 drivers, 6 flagged online, 6 with NULL `last_seen_at`, ZERO heartbeating.**
- The staleness-distribution query returned no rows, which follows from that.
- `backgrounded_at` does not exist yet. `last_seen_at` is `timestamptz`.

Two consequences. (a) The reaper has **never reaped anyone in production** — all
six online drivers are NULL and therefore skipped — so there is no regression
risk in changing it. (b) **The calibration data this design wanted does not
exist and cannot exist until the store build ships**, because nothing writes the
column until then. Any threshold picked now is picked blind.

## What's wrong today

`useDriverLocationBroadcast` is a plain JS `setInterval`. There are no
background modes in `app.config.js`, no TaskManager, no background location, no
keep-awake — so the heartbeat only ticks while the app is FOREGROUNDED.

That makes `last_seen_at` a measure of "the app is on screen", not "this driver
can be given a ride". A driver waiting at a stand with a locked phone is stale
in 60s and reaped in 5 min. Meanwhile ride offers arrive by PUSH, with
Accept/Decline notification actions — an architecture that assumes the app is
backgrounded. The delivery mechanism assumes background; the liveness check
treats background as death.

Not yet biting only because real drivers still report `last_seen_at = NULL`,
which both layers skip. It lands the day the heartbeat build is universal.

## The reframe

Exclusion is only correct when there is an alternative. Today's filter drops a
phantom even when dropping them means the ride goes unserved — which for a
three-car company at 2am is the difference between a served ride and a dropped
one. The fix is not a better threshold, it is to stop treating this as binary.

Three states instead of two:

| state | evidence | dispatch | location |
|---|---|---|---|
| **live** | heartbeat < 60s | first choice | fresh |
| **away** | no heartbeat, but backgrounded recently AND has a push token | fallback only | last known, stale |
| **gone** | no heartbeat, no recent background stamp | not dispatchable, reapable | stale |

`assign-ride` and `scheduled-release` try **live** drivers first and fall back to
**away** only when no live driver exists. A phantom in the fallback tier costs
one 30s offer timeout plus the `reassign-stale-rides` cycle — the cost of trying
is bounded and already handled, and the alternative was `no_drivers`.

## Status

- **Phase 0 (dashboard derives presence) — BUILT 2026-08-30**, committed in
  `mgcj-dashboard` as "Show driver presence as online/away/offline instead of a
  raw flag". NOT pushed (push auto-deploys to vellon-dispatch.vercel.app).
  `src/lib/presence.ts` mirrors the edge functions' `_shared/presence.ts`.
- **Phase 1 (dispatch tiering + reaper relaxation) — BUILT 2026-08-30** in
  `mgcj-app`: migration `20260766_liveness_reaper_relax.sql` (not yet applied),
  `_shared/presence.ts` `preferLive()`, and the pools in `assign-ride` and
  `scheduled-release`. Backend only — no mobile change was needed, see the
  `backgrounded_at` reversal below.
- Phase 2 (calibration) still waits on real heartbeats, i.e. the store build.

### Reversal: `backgrounded_at` was designed, then dropped (2026-08-30)

The plan above called for stamping a column when the app backgrounds, to tell
"pocketed" from "killed". Dropped before building, for three reasons:

1. **It duplicates `last_seen_at`.** The stamp would be written at the same
   instant as the final heartbeat, so a minute later it carries nothing
   `last_seen_at` does not already carry.
2. **No decision depends on the distinction.** A push notification reaches a
   force-quit app just as well as a pocketed one, and the offer IS the push.
3. **It would have misclassified the case that matters most.** A driver in a
   dead zone with the app OPEN writes no background stamp, so a
   backgrounded-only fallback tier would have called them gone — exactly the
   driver the rework exists to protect.

The fallback tier is therefore "stale but has a push token", with no attempt to
explain WHY they went quiet.

## Sequencing: measurement before enforcement

The store build is the first moment ANY of this goes live-fire, on every driver
at once. Shipping new thresholds in that same release means the first real data
and the first real enforcement arrive together — and if a number is wrong, the
failure mode is drivers silently not getting rides, with no baseline to debug
against. That is the exact bug this work exists to prevent.

So phase the work by a hard invariant:

> **Phase 1 ships only changes that can make a driver MORE dispatchable, never
> less.**

Every item below satisfies it. Reaper 5 → 45 min: more dispatchable. The away
fallback tier: strictly additive, it can only ever add candidates `assign-ride`
would otherwise not have considered. Keeping `current_lat/lng` on reap: no
dispatch effect. The background stamp: more dispatchable. The reap push: purely
informational. Nothing in phase 1 can cost a driver a ride they would get today,
so none of it needs data to be safe.

**Phase 2, after 2–4 weeks of real heartbeats:** re-run query 4 for the actual
staleness distribution, set `BACKGROUND_GRACE_MS` from it rather than from a
guess, and only then decide whether to tighten the NULL tolerance (which is
coupled to the seeded demo drivers — see `project_driver_liveness_phantom_reaper`).

## Changes

**Mobile (JS only — OTA-able, but belongs with the store build that first ships
the heartbeat to real drivers):**
- AppState listener writes `last_seen_at = now()` and `backgrounded_at = now()`
  on the transition to background/inactive; clears `backgrounded_at` and resumes
  beats on foreground. Best-effort: the OS may suspend before the write lands,
  in which case the driver degrades to today's behaviour. A force-quit gets no
  stamp, which is exactly the discrimination wanted — killed ≠ pocketed.

**DB (`drivers`):**
- `backgrounded_at timestamptz`.
- `reap_stale_drivers`: raise the default well past the filter (45 min), skip
  drivers whose `backgrounded_at` is inside the grace window, and STOP nulling
  `current_lat/current_lng` — `last_seen_at` already tells a reader how stale a
  position is, and nulling only destroys "last seen here 20 minutes ago".
  (Check the dashboard's driver-map readers before doing this: anything
  inferring offline-ness from a null coordinate needs to read `is_active` +
  `last_seen_at` instead.)

**`_shared/presence.ts`:**
- Keep `PRESENCE_STALE_MS = 60s` as the LIVE threshold (it still governs map
  and ETA freshness).
- Add `BACKGROUND_GRACE_MS` (start at 30 min) and `isDriverAway()`.
- `isDriverDispatchable()` becomes tiered rather than boolean at the call sites:
  live first, away as fallback. Coverage sites read `covered` off live drivers
  and `at_risk` when only away drivers remain — never `uncovered`, which means
  "no driver of this class exists at all".

**Reaper notification:** push the driver when they are flipped offline. It
queues at APNs/FCM and lands when they are back in coverage, at the same moment
`useOnReconnect` corrects their toggle — see `project_in_app_connectivity`.

## Background location — active rides only (added 2026-08-30)

Same root cause as everything above (the app only runs while foregrounded),
but it surfaces on the PASSENGER side, and there it is not a nicety.

**The bug.** During a ride the passenger watches a car and an ETA. Both come
from `watchPositionAsync` + `active_ride_eta_seconds` in
`DriverActiveRideScreen`, which is foreground-only. So the car and the countdown
both freeze when the driver takes a phone call, when their screen times out and
locks, or — for the whole trip — when they use their own nav app instead of
ours, which plenty of drivers do. The passenger gets a stationary car and a
stopped ETA with no indication anything is wrong. The current design silently
assumes the driver keeps our app on screen for the entire fare.

**Scope the fix to active rides.** Turn background location on at ride start,
off at ride end. Deliberately NOT while merely online-and-idle:

| | active-ride only | all shift |
|---|---|---|
| product justification | passenger tracking breaks without it | dispatch convenience |
| App Store review | canonical accepted case | harder to argue |
| privacy | only while carrying a passenger | tracks a person off-job |
| battery | bounded by trip length | continuous, the #1 driver complaint |

For an idle driver, "last seen 4 min ago, here" (Phase 0's faded car plus the
age) is enough for a dispatch decision. Do not pay the expensive half.

**This is a NATIVE change** — background location mode on iOS, a foreground
service on Android, plus TaskManager. Not OTA-able, needs a store build, moves
the fingerprint. iOS shows its blue indicator and Android a persistent
notification; both are user-visible and that is fine, it is the honest signal.

**Privacy is not an afterthought here.** Vellon is the vendor, not the driver's
employer — the taxi company is. Consent must be explicit and scoped to the fare,
and it belongs in the MSA / privacy-policy work already tracked in
`project_legal_compliance_prelaunch`.

**Cheap partial, same build:** keep the screen awake during an active ride so a
screen timeout cannot background the app in the first place. `expo-keep-awake`
is ALREADY in the tree (nested under `node_modules/expo/node_modules`, so the
native code is in the binary), but it is not resolvable from app code without
adding it as a direct dependency — which moves the fingerprint, so it rides with
the store build too. It does not help the driver-uses-their-own-nav case; only
background location does.

## Open questions

- `BACKGROUND_GRACE_MS = 30 min` is a guess and, per the verification above,
  MUST stay a guess until the store build produces real heartbeats. Phase 1 is
  built so that a wrong guess is harmless: too generous only means an extra
  offer timeout, never a missed ride.
- Query 5 (index list) came back with no visible rows, which cannot be literally
  true for a table with a primary key — re-run it before assuming
  `idx_drivers_active_last_seen` exists. Low stakes at 11 drivers, but the
  reaper does a global scan.
- Does a tiered fallback want to be per-company configurable? A large fleet
  might prefer strict exclusion (there is always another live driver); a
  three-car company never does.
