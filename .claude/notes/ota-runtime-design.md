# OTA runtime design — one-company app

Companion to `ota-updates-expo-updates.md` (which covers the config layer). This is
the runtime half: when the app checks, when it applies, and what it tells you.

---

## 1. The finding that reshapes everything: `extra` feeds the fingerprint

Measured, not assumed (`expo-updates fingerprint:generate --platform ios`, hash
compared with one `extra`-feeding env var changed):

```
baseline            e34a2506a6215dce89054888470a75e772c6628a
GOOGLE_MAPS_ROUTING_KEY changed   aaf19b6440972c45e2dcedd24ef549801d8eb7f5
```

The `expoConfig` fingerprint source hashes these keys:
`android, extra, icon, ios, name, orientation, platforms, plugins, runtimeVersion,
scheme, sdkVersion, slug, splash, updates, userInterfaceStyle, version`.

**`extra` is in that list, and `extra` is built from `process.env`.** Two consequences:

### (a) The env gap is worse than "the app is broken"

`eas env:list preview` / `production` are **empty**; local `.env` is populated. So a
build on EAS servers computes its runtime version from `extra = {undefined, …}`, while
an `eas update` published from Victor's laptop computes it from `extra = {real values}`.
Different fingerprints → **different runtime versions → the update silently never
reaches the build.** No error, no failed publish; it just never arrives.

So the env fix is not merely "so the app can reach Supabase" — it is a precondition for
OTA working *at all*. The rule that follows: **the environment used at `eas update`
must byte-match the environment used at `eas build`.** Always pass `--environment`
explicitly on both, and never publish from a shell relying on local `.env`.

### (b) Per-publish severity metadata via `extra` is ruled out

The tempting design — `OTA_SEVERITY=critical eas update …`, read back through
`Updates.manifest` — would change `extra`, therefore the fingerprint, therefore the
runtime version, therefore orphan every installed build. **Do not put per-publish
metadata in `extra`.** (`Updates.channel`, `updateId`, `createdAt` are safe: they come
from the update record, not the config.)

Also note `version` is hashed, so bumping `version: "1.0.0"` changes the runtime
version even under the fingerprint policy. That's fine and expected — a version bump
normally accompanies a store build — but it means a version bump is never a
JS-only change. `buildNumber`/`versionCode` are *not* hashed, so `autoIncrement` on the
production profile is safe.

---

## 2. Why the config layer alone is not enough

`fallbackToCacheTimeout: 4000` acts **only at cold launch**. But:

- A driver keeps the app foregrounded for an entire shift, and the OS rarely kills it.
- A passenger leaves it backgrounded for days.

The population that most needs a fix may go days without a cold launch. So the runtime
layer must check and fetch during a warm session, and — the actual design problem —
pick a moment to apply.

---

## 3. Severity: deliberately not built

There is no force-reload mechanism, and that is a decision, not an omission.

The only update that genuinely can't wait is one fixing a **crashing** bundle. But a
crashing bundle cannot run our hook — that case is handled entirely by the native
`fallbackToCacheTimeout` at the next relaunch, which the crash itself guarantees will
happen. The warm-session path therefore only ever carries **non-crash regressions**,
where waiting for a safe moment is always acceptable.

Forcing a reload while the gate is closed means reloading a driver mid-navigation or a
passenger mid-booking. That is worse than every bug it could fix.

If a force channel is ever genuinely needed, it belongs in a Supabase row (the app
already holds a realtime connection), **never** in the manifest — see §1(b).

**SETTLED 2026-08-23 — §3 stands, and the reasoning is now sharper than it was.**
Test 8 ran on the preview build. See §8 for the evidence; the short version is that the
two failure modes have two different mechanisms, and neither substitutes for the other:

| failure | what saves you |
|---|---|
| a bad OTA over a good bundle | expo-updates' automatic error recovery — reverts unaided |
| a crashing **embedded** bundle from the store | `fallbackToCacheTimeout: 4000` fetching the fix at splash |

The crash test exercised **row 1**, which is not the row this feature was bought for.
Row 2 is the scar-tissue scenario: there, error recovery has nothing to revert *to* —
the embedded bundle is the floor — so the splash-block fetch is the only thing that can
help, and `0` would have no answer at all because the crash would race a background
download and win. That is the precise justification for `4000`, and it is stronger than
the one originally written here.

Row 2 is **reasoned, not measured**: proving it needs a build with a deliberately broken
embedded bundle, to demonstrate a code path already watched working (the smoke test
applied inside the splash window at launch — same mechanism). Recorded honestly as such
rather than claimed as tested.

The original wording is kept below because the argument it makes is still the load-
bearing one.

**(Superseded) This section was PROVISIONAL until test-plan step 8 ran.** The argument above makes
crash-recovery behaviour load-bearing for a design decision, where before it was only a
verification nicety. Step 8 must separate two distinct mechanisms: (i) does
`fallbackToCacheTimeout: 4000` actually fetch and apply a fix on relaunch, and (ii) does
expo-updates' *automatic error recovery* independently revert to the last working bundle
when a newly downloaded update crashes? If neither fires reliably, §3 inverts and the
Supabase force row becomes necessary. Do not treat "no force mechanism" as settled
before that test.

---

## 3b. Key rotation is now a store-build event

Because `extra` is hashed and `extra` comes from `process.env`, **changing any of those
values changes the runtime version.** Known open items include swapping `pk_test_…` for
live Stripe keys in EAS env vars at go-live — that is a fingerprint change. Fine at
go-live, since it coincides with a build anyway. But every *future* key rotation
(Stripe, Supabase anon, Maps) orphans installed builds from OTA and requires a store
round trip. Budget for that; don't discover it during an incident.

`@expo/fingerprint` does offer an escape: `SourceSkips.ExpoConfigExtraSection` (4096)
excludes the `extra` section from the hash. **Not adopted, deliberately.** Hashing
`extra` fails *safe*: a publish from a shell with the wrong/missing env simply never
lands. Skipping it fails *open*: that same bad publish lands on working installs and
replaces their credentials with undefined. For a pre-launch one-company app the
fail-safe direction is worth more than OTA-able key rotation. The correct fix for the
build/publish mismatch is not to stop hashing — it is to pass `--environment`
explicitly on **both** `eas build` and `eas update` so they match by construction.

---

## 4. The reload gate is NOT the interstitial gate

Tempting, and wrong. `interstitialGateOpen` answers *"is it rude to show a card?"*.
A reload asks *"is it safe to destroy all in-memory state?"*. Those diverge in **both**
directions:

- **Too strict:** `menuVisible`/`helpVisible`/`inboxVisible`/`chatVisible`/
  `historyVisible` all close that gate, yet none hold unrecoverable state (G3 chat is
  server-side per Phase 1; history refetches). Worse, they create the failure this
  design otherwise has no answer for: **if the bug being fixed is what jams the gate,
  the fix never lands.** Not hypothetical here — `stuck in_progress` (E7) is a
  documented bug in this codebase, and it pins `hasActiveRide`/`hasAssignedRide` true
  indefinitely.
- **Too loose:** an interstitial over an in-flight `create-payment-intent` /
  `capture-payment` is harmless; a *reload* there can orphan a Stripe hold or lose a
  typed cash fare with the ride unsettled. The interstitial gate models no in-flight
  work at all.

So the reload gate is its own predicate, classified by severity:

- **HARD** (defer indefinitely): an active/assigned ride, or mid-booking with unsaved
  input. These are the states where in-memory loss costs money or a ride.
- **SOFT** (defer only until the next natural moment): every overlay/menu flag.
- **Escape hatch:** once this device has watched **the same blocker for > 2 h**
  (`HARD_BLOCK_ESCAPE_MS`), it is not a real ride — a Valley taxi ride is minutes — it
  is stuck state. Apply on the next foreground resume anyway. This is what stops
  E7-style stuck state from permanently starving the device of the very fix for it.

  **Key the clock to the blocker's identity.** Two wrong versions, both tried:

  1. *Time the block state in memory.* Unreachable — `DriverApp` remounts on sign-out
     and `activeRide` arrives async, so the first render after any remount reads `none`
     and resets the clock. A driver who opens and closes their app never accumulates
     the threshold.
  2. *Time the pending update instead.* Remount-immune, but wrong in the other
     direction, and the error only becomes dangerous as the threshold shortens: an
     update that had been waiting hours would reload a ride that started **thirty
     seconds ago** — exactly the reload this gate exists to prevent.

  What ships is (3): persist *when this device first saw this blocker*
  (`AsyncStorage`, key `ota.blockSince`, keyed by **ride id**). Remount-immune **and**
  incapable of letting a fresh ride inherit a stuck one's elapsed time.

  **A null id means "hard block that never escapes", and that is the correct value for
  every non-ride blocker** (the booking sheet, `showAssigned` with no ride). The stored
  clock is deliberately never cleared — clearing it on `level !== "hard"` would
  reintroduce failure (1), since the async ride fetch makes the first render after any
  remount read `none`. So a *constant* id would never reset either: `"booking-sheet"`
  would be written once, and every booking thereafter would match a days-old timestamp
  and escape immediately, eating the passenger's typed destination on essentially every
  booking. The hatch exists for stuck **server-side** ride state; local UI the user is
  actively driving is not stuck state and must never be reloaded out from under them.

  That second property is what makes 2 h safe. The longest realistic real fare is a
  Wolfville/Kentville → Halifax airport run at roughly an hour, so 2 h keeps ~2x margin,
  and the clock only ever runs against one continuously-observed ride.

The existing interstitial gate, for reference — the shape is similar, the semantics are
not:

- `DriverHomeScreen.tsx:427` — `!hasAssignedRide && !menuVisible && !historyVisible &&
  !editProfileVisible && !helpVisible && !inboxVisible && !chatVisible`. Note
  `DriverApp` unmounts this whole screen during an active/assigned ride (single
  conditional-return router), so "no active ride" is structural, not a check.
- `PassengerHomeScreen.tsx:1104` — `!hasActiveRide && sheet === null && !reviewTarget`
  plus every overlay flag.

Feeding the same predicate to the updates hook is the whole point: two consumers of one
gate stay correct together. Three separate notions of "is it safe to interrupt" is how
they drift apart, and the drift would show up as a reload mid-ride.

---

## 5. Components

### `src/lib/updates.ts`
- `otaEnabled()` → `Updates.isEnabled && !__DEV__`. **Every entry point must no-op when
  false**, or day-to-day Expo Go iteration breaks (Expo Go never consumes updates).
- `describeBuild()` → app version, native build number, `Updates.channel`,
  `Updates.isEmbeddedLaunch`, short `Updates.updateId`, `Updates.createdAt`.

### `useOtaUpdate(...)`
**Do not hand-roll the state machine.** `Updates.useUpdates()` (verified present in
v29) already exposes `currentlyRunning`, `availableUpdate`, `downloadedUpdate`,
`isUpdateAvailable`, `isUpdatePending`, `isChecking`, `isDownloading`,
`isStartupProcedureRunning`. Our hook owns only the two parts that are genuinely ours:
**trigger scheduling** and **the gate decision**.

Check triggers:
1. mount,
2. `AppState → 'active'` (foreground resume) — the highest-value trigger, since it is
   the one event that reliably fires for a long-lived session,
3. a long interval while foregrounded (30 min) — for a driver on a 12-hour shift who
   never backgrounds the app.

Apply policy:
- `ready && gateOpen` → `Updates.reloadAsync()`.
- Strongly prefer applying **on foreground resume**: a reload at that instant reads as
  a normal cold start. A reload while someone is looking at the screen reads as a crash
  — same pixels, opposite interpretation.
- If `!gateOpen`, hold `ready` and wait. The gate opens on its own.

### Mount points — deliberate, and asymmetric

- **Driver: `DriverApp`**, not `DriverHomeScreen`. `DriverApp` is always mounted for a
  driver and holds the authoritative ride state (`activeRide`, `pendingRide`,
  `ACTIVE_STATUSES`), so HARD blockers are known exactly. It cannot see
  `DriverHomeScreen`'s overlay flags — acceptable, because those are SOFT and we only
  apply on foreground resume anyway. Mounting on `DriverHomeScreen` instead would look
  tempting (that screen unmounts for the whole active ride, making "no reload mid-ride"
  structural) but it also unmounts the *escape hatch*, so a driver stuck in an E7 ride
  could never receive the fix. That is the exact failure being designed against.
- **Passenger: `PassengerHomeScreen`**, which already computes both the hard and soft
  state, and whose overlays are absolutely-positioned siblings rather than a navigator
  stack — so no overlay can unmount the hook. It is *not* "always mounted": `App.tsx`'s
  `RootNavigator` renders it only for an authenticated non-driver, so it unmounts on
  sign-out and throughout the pre-auth stack. That is fine behaviourally (nothing needs
  updating while signed out) but the distinction matters to anyone extending this.
- **Admins get the passenger gating.** Per the repo CLAUDE.md there is no admin mobile
  screen, so `profile.role === 'admin'` also renders `PassengerHomeScreen`. Harmless —
  admins have no active ride — but it is why the passenger gate, not the driver one,
  governs them.

A consequence worth stating: checking/downloading only happens where the hook is
mounted, so a driver mid-ride is not pulling a bundle over cellular while navigating.
That is a feature, not a limitation.

### In-flight Stripe calls: covered by the HARD blockers, not by a separate registry

Considered a `beginCriticalOp()`/`endCriticalOp()` registry and rejected as redundant:
`capture-payment` and the cash fare-entry modal both live inside the active ride
(HARD-blocked); `create-payment-intent` runs with the booking sheet open (HARD-blocked).
The only money-adjacent call outside a hard block is `save-card`, which is idempotent
server-side — a reload there loses UI, not money. If a money path is ever added outside
those two states, this reasoning expires and the registry becomes necessary.

### Visibility (support-critical, currently missing)
`HelpSupportScreen` hardcodes `M&G C&J Driver App · v1.0` (shared/:165) and
`Version 1.0.0` (passenger/:175). Both are lies the moment an OTA lands. Replace with
real values incl. the short update id and its date. **Without this you cannot tell
which bundle a driver reporting a bug is actually running** — which is precisely the
situation OTA creates, since two drivers on the same store version can now be on
different JS.

### Deliberately NOT built
- **No "Update available — tap to restart" prompt.** It asks the user a question they
  have no basis to answer, and the gate already picks a moment they won't notice.
- **No check on every screen focus** — needless battery/radio on a driver phone that is
  already running GPS broadcast, realtime, and navigation.

---

## 6. Known gap, not closed here: native/runtime drift is silent

When a native change ships, the runtime version changes and **old binaries stop
receiving updates with no signal at all** — they simply never see another update again.
expo-updates has no built-in "your binary is too old" mechanism.

v1 mitigation is §5's visibility: support can ask what the Help screen says. A real fix
(a Supabase `min_supported_runtime` row driving a blocking "update from the App Store"
screen) is a follow-up, and should be designed with the store-review round trip in mind.

---

## 7. What was built (2026-08-23)

| File | Role |
|---|---|
| `src/lib/updates.ts` | `otaEnabled()`, the `ReloadBlock` type, thresholds, `getBuildInfo`/`formatBuildInfo` |
| `src/hooks/useOtaUpdate.ts` | trigger scheduling + the gate decision (wraps `Updates.useUpdates()`); persists `ota.blockSince` for the escape hatch |
| `src/screens/driver/DriverApp.tsx` | mounts the hook; HARD when `activeRide \|\| assignedRide \|\| pendingRide \|\| showAssigned`, keyed by ride id |
| `src/screens/passenger/PassengerHomeScreen.tsx` | mounts the hook; HARD on `hasActiveRide \|\| sheet !== null`, SOFT on any overlay |
| both `HelpSupportScreen`s | hardcoded `v1.0` / `Version 1.0.0` → live build identity |

`Updates.useUpdates()` supplies the state machine (`isUpdatePending`, `isChecking`,
`isDownloading`, `currentlyRunning`), so the hook only owns triggers and the gate.

Typecheck: `npx tsc --noEmit` reports no errors in any new or touched file. (Four
pre-existing errors remain in `useNotifications.ts`, `DriverApp.tsx:1007` and the known
dead `screens/driver/useDriverRating.ts` — all present on clean `HEAD`, verified by
stashing.)

### Resume ordering

The resume handler applies an already-downloaded update **first**, then checks — and if
that check is what pulled the bundle down, applies again on the *same* resume using
`fetchUpdateAsync()`'s return value rather than `isUpdatePending` (which has not
necessarily propagated through `useUpdates()` yet). Without that second apply, an update
discovered on a resume would wait for the *next* one, costing a full pick-up/put-down
cycle per update on a phone used in short bursts.

### Accepted limitation

A driver who never backgrounds the app for an entire 12 h shift downloads the update but
does not apply it until the next resume. Applying mid-session was rejected: it is
indistinguishable from a crash to the person watching. The 30-minute foreground check
still gets the bytes down, so the apply is instant when the resume comes.

---

## 8. Runtime test plan — RESULTS

**Verified 2026-08-23 on the preview build** (`b867d5ea`, commit `56bd1e2`,
`runtimeVersion a6156ffb…`, channel `preview`):

- **Parity, end-to-end.** The build's runtime version equals the published update's
  runtime version equals the locally computed fingerprint — `a6156ffb…` all three. The
  silent failure this whole document is about is closed, confirmed against real
  artifacts rather than a simulated env.
- **Test 9 (delivery) PASS** and **test 13 (build identity) PASS**: a no-op update
  (`01a030d1`) published to `preview` landed on relaunch, and the Help & Support footer
  moved from `base` to `01a030d1 · Aug 23`. The build-identity line doubles as the
  delivery probe, which is why the first test could be made zero-risk.
- Older `development` builds report `runtimeVersion: None` — no expo-updates in them, so
  they can never receive an update. Expected; noted so it isn't mistaken for a fault.

**Ordering correction, important.** An earlier draft put the crash test (8) first
because it settles §3. That is wrong and dangerous: if delivery were broken and a
crashing bundle went out first, the device would be bricked to a reinstall with no OTA
path back. **Always prove delivery with a benign update before deliberately shipping a
crash.**

### Test 8 (crash recovery) — PASS, 2026-08-23

Method: injected a module-scope `throw` at the top of `App.tsx`, published to `preview`
as `01a030da`, then published the fix. Two false starts worth keeping:

- **"It's not crashing" is not evidence of anything.** That observation is equally
  consistent with "the bad bundle never arrived" and "it arrived, crashed, and was
  reverted before the user saw it" — from outside the app the two are identical. Do not
  reason from it; instrument instead.
- **Verify the crash reached the bundle.** `expo export` produces Hermes bytecode, so a
  plain `grep` finds nothing; the string table concatenates entries, so the marker shows
  up as `…RECORD_AUDIO` + `TA crash test: …` under `strings -a`. Confirmed present, which
  ruled out a no-op publish before any device time was spent.

Resolved with `Updates.readLogEntriesAsync()`, surfaced as a temporary long-press on the
Help & Support version line. A raw dump was 381 entries — unreadable and uncopyable in an
`Alert` — so the second iteration computed a verdict instead. Result:

```
running 01a030e9
SEEN: 17 entries reference 01a030da — it reached the device
total=440  crashRefs=17  errors=1
codes: Unknown x1, JSRuntimeError x1
```

`JSRuntimeError` is the crash firing. The device downloaded the bad bundle, launched it,
it threw, and expo-updates reverted to the last good update **unaided and fast enough
that nothing was visible to the user**. Measurement (ii): PASS.

Consequence to remember: a failed update is marked failed *on that device* and is never
retried, so re-testing a crash requires a **new update id** — republishing the same
content will not do it.

Also confirmed incidentally: ~380–440 log entries per 24h is normal volume, not a
symptom. expo-updates logs every check, and ours runs at launch, on every foreground
resume, and every 30 minutes.

### Remaining steps

Config-layer steps 1–7 are in `ota-updates-expo-updates.md`. These extend it.

8. **Crash recovery — settles §3, run this first.** Publish a bundle that throws
   unconditionally at the top of `App.tsx`, install, confirm the crash, then publish the
   fix. Record separately: (i) does the 4 s splash block fetch-and-apply on relaunch,
   and (ii) does automatic error recovery revert to the last good bundle unaided? If
   neither fires, §3 inverts and a Supabase force row is required.
9. **Warm-session apply.** With the app foregrounded, publish an update; wait for the
   download; background the app, then foreground it. The change should be live and the
   reload should read as a cold start.
10. **HARD block holds.** Start a ride (driver on an active ride / passenger with a
    booking sheet open), publish an update, background and foreground. The app must
    **not** reload. Complete the ride, background/foreground — now it must.
11. **Escape hatch — across remounts, and NOT on a fresh ride.** Temporarily drop
    `HARD_BLOCK_ESCAPE_MS` to ~2 min, pin a ride active, confirm the reload happens on
    the resume after the threshold. Then two regression cases, one for each way this
    was got wrong before:
    - **Survives remounts:** repeat while backgrounding/foregrounding several times
      during the wait, and once with a sign-out/sign-in mid-wait. The escape must still
      fire. (v1 timed the block state, which resets on every remount.)
    - **Does not fire on a fresh ride:** let an update sit pending well past the
      threshold with no ride, then start a ride and immediately background/foreground.
      It must **not** reload. (v2 timed the pending update, which would have.)
    - **Never fires on the booking sheet:** with an update pending well past the
      threshold, open the booking sheet, type a destination, background/foreground. It
      must **not** reload. (v3 passed a constant id here, whose clock never resets.)

    Restore the constant afterwards — **do not ship the shortened value**.
12. **Expo Go is unaffected.** Confirm normal Expo Go iteration still works
    (`otaEnabled()` is false there; every entry point must no-op).
13. **Build identity.** Open Help & Support before and after an OTA: it should read
    `… · base` on a fresh install and `… · <8-char id> · <date>` once an update lands.
