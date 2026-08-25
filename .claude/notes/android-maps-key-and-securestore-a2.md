# Android Maps key restriction + SecureStore session size (A2)

Two separate pieces of work that happened to land in the same pass. They do
**not** ship together: A2 is JS-only and rides an OTA; the Maps key work is
console-side and (if done wrong) a store-build event.

---

## A2 — MEASURED 2026-08-24 (Expo Go, Android, passenger account)

```
[SecureStore] sb-hhsqwmftrrmtodvvuyxq-auth-token: 2014 bytes — 34 bytes of headroom
breakdown: access_token=872 token_type=6 expires_in=4 expires_at=10
           refresh_token=12 user=1020
             user.email=0  user.phone=11  user.identities=411
             user.user_metadata=92  user.app_metadata=42
```

**Verdict: A2 closes, with one named tripwire.** 2014 of 2048. The limit is
`VALUE_BYTES_LIMIT = 2048`, tripped on `bytes > 2048`, and `isValidValue` only
`console.warn`s and returns `true` — so on `expo-secure-store@15.0.8` nothing
throws at any size, and Android's `SharedPreferences.putString` has no per-string
cap. Being over the line costs nothing *today*.

34 bytes is thin, so the question is what can grow:

- **`user.email=0` is not headroom waiting to be spent.** The receipt email lives
  in `profiles.email` (a table row), NOT `auth.users.email` — `ProfileScreen`
  writes the row and `send-ride-receipt` selects from it. Nothing in `src/` calls
  `auth.updateUser`. Receipts work with an empty auth email. This path adds 0 bytes.
- **`user.identities=411` is one identity (phone).** A second would need
  `linkIdentity` or anonymous-identity linking; neither appears in `src/`, and the
  guest flow *retires* the guest row rather than merging it. Not a live path.
- **`user_metadata=92`** is the name — grows with a longer name, bounded and small.
- **THE REAL TRIPWIRE: `access_token=872` is 43% of the budget.** Adding custom JWT
  claims grows it directly. `company_id`/`role` claims are exactly what "true
  multi-tenancy hardening" would add, and ~40-80 bytes of claims crosses 2048.

**So the failure needs BOTH: custom JWT claims (or similar growth) AND an SDK that
makes the warning throw.** Neither alone breaks anything. Do NOT pre-build
chunking — the shrink-case trap documented below recreates the exact login loop it
would exist to prevent.

**Re-measure when:** adding custom JWT claims, or bumping the Expo SDK /
`expo-secure-store` (check release notes for the warning becoming a throw). The
`__DEV__` probe in `src/lib/supabase.ts` prints total + breakdown on every session
write; one Expo Go sign-in gives the number.


## A2 — SecureStore session size

### The premise was wrong, and the source says so

The worry was: `expo-secure-store` has a ~2KB ceiling on Android, a Supabase
session with a fat JWT can approach it, and **a truncated write is how you get
a login loop**. Read against `expo-secure-store@15.0.8` as installed, there is
no truncating write anywhere in the module:

- `isValidValue()` (`build/SecureStore.js:154`) **warns and returns `true`**.
  It does not throw and does not shorten the value. The message itself is
  forward-looking: *"In a future SDK version, this call may throw an error."*
- Android (`SecureStoreModule.kt` `setItemImpl` → `saveEncryptedItem`) encrypts
  with `AESEncryptor` (AES/GCM, symmetric — no plaintext size bound) and lands
  in `prefs.edit().putString(...).commit()`. **SharedPreferences has no
  per-string cap.** The old 250-byte limit people remember belongs to the
  legacy RSA `HybridAESEncryptor` path, which is only used for reading old
  entries on pre-API-23 devices.
- iOS is the Keychain, which has no ~2KB issue either.

So the write either succeeds or throws. It never silently half-writes. The
feared login loop has no path to happen on this SDK version.

### What *is* real

1. **The future-throw.** If a later SDK makes `setItemAsync` reject on
   oversize, supabase-js's `setItem` rejects, the session never persists, and
   the app becomes a login loop — the feared outcome, arriving through the
   door the warning actually names. Gated on an SDK bump, so it is a
   watch-item on upgrade, not a bug today. Deliberately **not** pre-fixed:
   see "why no chunker" below.
2. **The warning is JS-side, so it fires on iOS too.** If it shows up in an
   iOS log it is not a second bug — Keychain is fine.
3. **`saveEncryptedItem` returns `Boolean` and `setItemImpl` discards it.** A
   failed `commit()` is silent. Not size-driven, but it means "the write
   succeeded" is never actually verified on Android.

### The measurement (do this, it is the deliverable)

`src/lib/supabase.ts` now logs the byte length of every value supabase-js
persists, under `__DEV__` only, **length never value** — it is a live access +
refresh token pair.

    [SecureStore] sb-hhsqwmftrrmtodvvuyxq-auth-token: NNNN bytes

**No build needed.** Expo Go on Android exercises the same native module and
the same session shape; the client is constructed at import time, so the app
could not boot if SecureStore were failing there. Run the app on Android, sign
in as a driver, read the number off the Metro log.

- **Comfortably under 2048** → close A2. Record the number here and move on.
- **Over 2048** → the warn is firing today and the SDK-bump risk is live.
  Only then consider chunking.

### Why no chunker was pre-built

Chunking a value across `key.0`, `key.1`, … is the obvious fix and it carries
three traps, one of which is our own history:

1. **Shrink case.** Write 3 chunks, later write 2 — chunk `.2` is left stale on
   disk. Reassembly yields corrupt JSON, `JSON.parse` throws, supabase-js sees
   no session: *the exact login loop, introduced by the fix.* Any chunker must
   delete orphans on every write.
2. **Migration.** The existing single-key value has to stay readable, or the
   release that ships chunking silently logs out every current user. OTA is
   live, so that lands without store review and rolls back only via another
   OTA.
3. **Key charset.** `/^[\w.-]+$/` — `.` and `-` are safe separators; `:` or `@`
   re-creates the SecureStore-charset bug that killed the driver device lock
   silently for six weeks.

Building all that for a limit we have not yet measured, against a failure mode
the source says cannot occur, is strictly negative value.

---

## Android Maps key — the blocker, and what it actually is

CLAUDE.md said *"Android build still needed to extract the SHA-1."* Half stale,
half true, and the true half is different from what was written.

### There is no keystore at all

Queried EAS directly (GraphQL, `app.byId.androidAppCredentials`):

    "androidAppCredentials": []

Nothing has ever been generated. So there is no SHA-1 to extract — one has to
be **created** first. But that still does not need a build:

    eas credentials --platform android      # → Keystore → set up a new keystore

is interactive (there is no `--non-interactive` flag on this command in
eas-cli 18.10.0 — it errors), so run it as `! eas credentials --platform
android` so the output lands in the session. Cutting an Android build
generates one as a side effect too, which is the option to take if a build is
wanted anyway.

### The key in the Android slot is NOT an Android-display key

This was the assumption worth checking, and it did not hold. Root CLAUDE.md
describes `GOOGLE_MAPS_KEY` as "a temporary/unrestricted value" — which reads
as *the `mgcj-mobile-android-display` key, sitting unrestricted*. It is not.
Probed all three keys against the web-service APIs (no gcloud CLI on this box,
so this is behavioural, not a console read):

| key | directions | distance matrix | places | geocode | app restriction |
|---|---|---|---|---|---|
| `GOOGLE_MAPS_IOS_KEY` | denied | denied | denied | denied | yes (iOS SDK only) ✅ |
| `GOOGLE_MAPS_ROUTING_KEY` | **ok** | **ok** | **ok** | denied | **none** |
| `GOOGLE_MAPS_KEY` (android slot) | **ok** | **ok** | **ok** | denied | **none** |

The iOS key is correctly locked down — it refuses every web service, which is
what a Maps-SDK-only key does. `GOOGLE_MAPS_KEY` has the **identical
capability profile to the routing key** (different value — md5s differ — but
the same permissive config) and answers a plain `curl` with no package name or
signature, i.e. no application restriction at all.

So the Android slot holds a routing-shaped stand-in, not a display key. Two
consequences:

1. **It is a live billing exposure, not just an untidy TODO.**
   `android.config.googleMaps.apiKey` is written into `AndroidManifest.xml`,
   which is trivially extractable from any APK. Anyone with the file gets
   Directions + Distance Matrix + Places on our billing account, from
   anywhere, with no app restriction to stop them — and per root CLAUDE.md the
   daily quota caps still are not set (Distance Matrix's per-day quota is not
   editable on the free trial). The budget-alert backstop is reactive only.
2. **The fix is a key *value* change, which is a fingerprint change.** The
   re-measurement of 2026-08-24 (Android `c74583d6…` → `c03f86d3…`, iOS
   `2572e0f0…` → `299990b4…`) means pointing the app at a real display key
   moves **both** runtime versions — the whole `expoConfig` is hashed, not a
   per-platform slice, so this is not an Android-only change. That would
   normally be a store-build event that splits OTA delivery. (The earlier
   `278462f8…` → `20fa11cf…` figures came from `expo-updates
   fingerprint:generate`, which returns a constant in this project — see
   CLAUDE.md. Measure with `@expo/fingerprint` directly.)

**But right now that costs nothing**, and this is the part worth acting on:
there is no Android build in existence and no Android keystore, so there is no
installed base to orphan and no published OTA on the old Android runtime
version to strand. Doing the swap *before* the first Android build is free.
Doing it after is not. This is the cheap moment and it does not stay cheap.

(The generic principle still holds and is worth keeping: a key **restriction**
is a console-side property, changes no value, and never moves the fingerprint.
It just does not apply here, because this slot needs a different key, not a
restriction on the one it has.)

### Which SHA-1 goes in the restriction

An Android Maps key restriction is *package name + SHA-1*, and there are up to
three fingerprints in play. Getting this wrong gives maps that work perfectly
in internal-distribution preview and blank tiles for every real user:

| Fingerprint | When it is the one in force |
|---|---|
| EAS build/upload keystore | internal-distribution `preview` builds, sideloaded APKs |
| **Google Play App Signing** | **every store install** — Play re-signs the upload |
| local debug keystore | `expo run:android` on a dev machine |

`eas.json` has `autoIncrement` and a `submit.production` block, so Play is in
the plan. Add **every applicable** fingerprint, and remember the Play one only
exists after the first upload to Play Console (App integrity → App signing).

Package name is `com.mgcj.app` for both `android.package` and the iOS bundle
id.

### Env: the preview blocker is stale, production is empty on purpose

CLAUDE.md says `eas env:list preview` and `production` are *both* empty. Only
`production` is now:

- `development` — 6 vars
- `preview` — 6 vars ✅ (an Android preview build is safe to cut)
- `production` — empty, deliberately

Also verified all six local `.env`/`.env.local` values are **byte-identical**
to the EAS `preview` values (md5-compared). That matters beyond convenience:
since `extra` and the maps key are both hashed into the fingerprint, a local
`eas update` and an EAS `preview` build only produce the same runtime version
while those values match. They do. Re-check after any key rotation.

---

## Order of operations

1. Measure the session size in Expo Go on Android → close or open A2.
2. `! eas credentials --platform android` → generate keystore → record SHA-1.
3. Google Cloud console → `mgcj-mobile-android-display` → confirm it has
   **only** Maps SDK for Android enabled, then Application restrictions →
   Android apps → add `com.mgcj.app` + that SHA-1.
4. Point `GOOGLE_MAPS_KEY` at that key — in the EAS `preview` env **and** in
   local `.env`/`.env.local`, which must stay byte-identical or local
   `eas update` and the EAS build land on different runtime versions. This is
   a fingerprint change; it is free only because nothing Android has shipped
   yet. Do it **before** step 5, not after.
5. Cut the Android `preview` build. This is also the moment to ship the
   `last_seen_at` heartbeat that is still only on one device.
6. After the first Play upload, add the Play App Signing SHA-1 to the same key.
