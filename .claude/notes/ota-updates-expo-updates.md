# OTA updates (expo-updates) — B1/B2

**Why:** the competitor teardown's most damaging pattern is a crash regression that
stays broken for weeks and leaves permanent 1★ scar tissue (Casino 2015 iOS, Kami
v14.16). Without an update channel our fix for a launch-crash is a full store round
trip. Adding expo-updates *before* first store submission is the only time it's
cheap — it cannot be retrofitted onto builds already installed.

## What was done (2026-08-23)

- `npx expo install expo-updates` → `expo-updates@~29.0.20` (SDK 54 compatible).
- `app.config.js`: added `updates.url` (project `1df2c110-…`),
  `updates.fallbackToCacheTimeout: 4000`, and `runtimeVersion: { policy: "fingerprint" }`.
- `eas.json`: added `"channel"` to all three build profiles
  (`development`/`preview`/`production`). **A build with no channel receives nothing** —
  none of the profiles had one.

Verified: `npx expo config --type public --json` resolves the `updates` block and
`extra` still carries the Supabase/Stripe/Maps values;
`npx expo-updates fingerprint:generate --platform ios` succeeds, so the fingerprint
policy is usable on this setup.

## Load-bearing decisions

- **`fingerprint`, never `appVersion`.** With `appVersion`, bumping `version: "1.0.0"`
  orphans every installed build from future updates. `fingerprint` changes
  automatically when native deps/config change, which is exactly the thing that stops
  a JS bundle landing on a binary missing a native module it calls. Note `eas.json`
  and `.gitignore` are both fingerprint *sources* — editing either changes the runtime
  version and cuts existing builds off from new updates.
- **`fallbackToCacheTimeout: 4000`, deliberately not `0`.** `0` launches immediately
  from the cached bundle and downloads in the background — which is the setting **least**
  able to handle a launch crash, the exact incident this work was justified by: the
  crash races the download and usually wins (relaunch, crash, relaunch, crash, the fix
  never lands). `4000` blocks at the native splash, fetches, and launches the
  **replacement** bundle, so the fix applies on the first relaunch before the crashing
  JS runs. Cost: up to 4s of cold start on a bad network, falling back to the cached
  bundle on timeout. Chosen by Victor 2026-08-23. **Do not "optimise" this back to 0.**
- **This is worth exactly zero until a build carrying it is on devices.** expo-updates
  is a native module. Bundle this into the same build as the committed-but-unshipped
  `last_seen_at` heartbeat (see root CLAUDE.md → Known open items) and run that item's
  two liveness tests on the same build.

## Env parity — step 1 DONE 2026-08-23

Was a blocker; now fixed. `eas env:list preview`/`production` were empty while local
`.env`+`.env.local` were populated, so an EAS build and a local publish computed
**different fingerprints** and updates would silently never land.

Demonstrated rather than asserted — dropping a single var changes the runtime version:

```
all vars present                     166e9047b53bea88580096747a09fc080285a49d
GOOGLE_MAPS_KEY absent               003768ec922b016486b0b1a64e318ba6d266a9ae
```

(Use `EXPO_NO_DOTENV=1` for this — the Expo CLI auto-loads `.env`/`.env.local` and will
silently defeat an `unset`.)

Two real gaps found and closed:

- **`GOOGLE_MAPS_KEY` was missing from EAS `development` too**, though present locally —
  the same trap, already live on the profile actually in use.
- `GOOGLE_MAPS_IOS_KEY` and `GOOGLE_MAPS_ROUTING_KEY` live in `.env.local`, not `.env`.

All six vars (`SUPABASE_URL` plaintext; the rest `sensitive`, matching what
`development` already used) are now set on `development` and `preview`. Verified by
pulling the remote env and re-computing:

```
fingerprint from local .env       e34a2506a6215dce89054888470a75e772c6628a
fingerprint from EAS preview env  e34a2506a6215dce89054888470a75e772c6628a   PARITY OK
```

`eas env:pull` defaults `--path` to **`.env.local`** and will clobber it. Always pass an
explicit `--path`, and delete the pulled file afterwards — it contains sensitive values
in plaintext.

### `production` left empty ON PURPOSE

It is not needed until go-live, and the choice there is between two failure modes.
Populating it now means copying the **sandbox** `pk_test_…` Stripe key, so a production
build would look configured and take payments that never charge — wrong, and silent.
Leaving it empty means such a build cannot even reach Supabase: broken loudly, on the
first screen. Loud beats silent for a state nobody should be in.

**Add to the go-live checklist:** populate `production` with all six vars *including the
live Stripe key*, in the same pass. Note this changes the fingerprint (`extra` is
hashed), so it requires a fresh build — go-live involves one anyway.

## Test plan (run once a preview build is on a device)

1. `eas build --platform ios --profile preview` — install on device, confirm the app
   works (this also proves the env fix above).
2. Make a trivially visible JS change (e.g. the version string in
   `src/screens/shared/HelpSupportScreen.tsx`).
3. `eas update --branch preview --environment preview --message "ota smoke test"`.
4. Relaunch the app **twice**. Confirm the change appears on the second launch, not the
   first — if it appears on the first, the apply timing differs from what's documented
   here and this note should be corrected.
5. On device, confirm `Constants.expoConfig.extra.supabaseUrl` is still set (i.e. the
   OTA didn't strip credentials) by exercising any screen that queries Supabase.
6. **Rehearse the rollback before ever publishing to production.** The insurance isn't
   complete until un-shipping a bad update is a known move: `eas update:rollback`, or
   republish the prior update to the branch. An OTA can itself be the crash.
7. Rule: land every change on `preview` first, promote to `production` after.

## Not in scope: pitch-demo branding

OTA ships the JS bundle and its assets **only**. It can change in-app copy (the
`WelcomeScreen` wordmark, both `HelpSupportScreen` FAQs, `DriverWelcomeScreen`/
`DriverSignUpScreen` strings) but **not** the springboard app icon, the app name under
it (`name: "M&G C&J"`), the splash image, the bundle ID, `plugins`, or Info.plist.
So it does not deliver "hand them a phone and the home screen says their company".

The real mechanism for that is runtime config: `grep -rn "from('companies')" src/`
returns **zero hits** — the app never reads the companies table, so all branding is
hardcoded across 8+ files. Per-company demo branding should be a data-driven read of
the company row (name/logo), which also swaps without a bundle publish or two app
launches. Keep the two goals separate; don't justify expo-updates on branding.

## Settle before cutting the build (fingerprint sources)

Under the `fingerprint` policy, **dependency versions feed the fingerprint**. Anything
bumped *after* the build ships orphans that build from every future update — the first
routine housekeeping commit would silently void the insurance on the only binary
carrying it. `npx expo install --fix` was therefore run now, pre-build (`expo` →
`~54.0.37`, `expo-constants` → `~18.0.14`); `npx expo-doctor` is 18/18. Same logic for
`eas.json` and `.gitignore`, both of which are fingerprint sources: settle them
pre-build.

## Still to confirm on device: crash recovery, end to end

`fallbackToCacheTimeout` is settled at `4000` (see above), but the *behaviour* it buys
has not been observed yet. Also relevant and not yet confirmed: expo-updates has **client-side error recovery**
that reverts to the previous working bundle if a *newly downloaded* update crashes
shortly after launch. That is separate from the server-side `eas update:rollback` in
test-plan step 6, and it is why a nonzero timeout is less risky than it sounds.

**Prove it, don't reason about it.** Add this as test-plan step 8: publish a bundle
that throws unconditionally at the top of `App.tsx` to the preview channel, install it,
then publish the fix and confirm a single relaunch recovers. If it takes two relaunches,
or none, 4000ms is too short and this note is wrong — correct it here and in
`CLAUDE.md` rather than leaving the claim standing.
