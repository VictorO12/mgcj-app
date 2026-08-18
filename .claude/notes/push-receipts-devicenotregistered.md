# Push receipts / `DeviceNotRegistered` — the silent-delivery blocker

Design. Nothing built. Own work item; **must ship before G3 §15** (see §7).

---

## 1. What Expo actually promises

Sending a push is **two phases**, and we only ever use the first:

1. **Ticket** — returned synchronously by `POST /push/send`. Means "Expo accepted the
   payload." Max 100 messages per request.
2. **Receipt** — fetched later from `POST /push/getReceipts` using the ticket id. Means
   "Expo handed it to APNs/FCM, and here is what happened." Max 1000 ids per request.
   **Receipts are kept 24 hours**, and Expo recommends waiting **15 minutes** after sending
   before polling.

`DeviceNotRegistered` appears in **both**, and the distinction is the whole problem:

- In a **ticket**: the token was already invalid when we sent.
- In a **receipt**: the device unregistered *after* Expo accepted it. Expo's own docs say
  this "takes an undefined amount of time and is often impossible to test by uninstalling
  your app and sending a push notification shortly after."

Expo's requirement is explicit: on `DeviceNotRegistered`, "stop sending notifications to
this device's push token until it re-registers with your server."

---

## 2. What our code does

**Nothing.** The typical `sendPush` is:

```ts
await fetch(EXPO_PUSH_URL, { method: 'POST', ... })
```

The response body is never read. There are **9 hand-rolled copies of `sendPush` across 17
send sites** — there is no `_shared/push.ts`, unlike `fare.ts` and `presence.ts`.

The single exception is `scheduled-ride-digest`, which inspects tickets
(`tickets[j]?.status !== 'ok'`) — but only to decide whether to advance its watermark. It
never nulls a token either.

**We have never fetched a single receipt.**

---

## 3. Why this is a go-live blocker, not hygiene

A token goes dead three ways: app uninstalled, app reinstalled (new token issued), or the
user revokes the notification permission in OS settings. In all three the **old token stays
in the database forever**, and it is indistinguishable from a working one.

**For drivers** — `isDriverDispatchable()` is `live AND push_token IS NOT NULL`. A dead
token passes that filter. So the driver:
- shows as available to `assign-ride` and in every coverage site,
- gets offered rides that never appear on their phone,
- times out after 60s and gets cycled by `reassign-stale-rides`,

while dispatch's dashboard reads `covered` and the driver believes they're online. The
go-online gate added 2026-08-15 requires `registerPushToken()` — but that only closes the
**never-had-a-token** case, not the **had-one-and-it-died** case.

**For passengers** — every ride status notification silently vanishes.

---

## 4. Ticket checking is NOT the fix

Tempting framing: "check tickets synchronously, it's the cheap 80%." It isn't.

Tickets carry `DeviceNotRegistered` only for tokens invalid **upfront**. The revoked-
permission and reinstalled-app cases — i.e. the actual blocker — surface only in the
**receipt**. The proof is already in the repo: `scheduled-ride-digest` has inspected
tickets since 2026-08-15 and this blocker is still open.

Reading tickets is a worthwhile correctness cleanup on the 8 copies that discard the
response entirely. **It does not close this item.** Do not let it be mistaken for the fix.

---

## 5. The fix

### 5.1 Two detectors, because they catch different failures

| | Uninstalled app | Revoked permission |
|---|---|---|
| **Client-side** (below) | never runs again — **can't catch** | catches at next app launch |
| **Server-side receipts** | catches | catches, but only after a wasted push |

Both are needed. Neither is redundant.

### 5.2 Client-side: null our own token when permission is gone (cheap, fast)

`registerPushToken` (`useNotifications.ts:36`) already returns
`{ token: null, reason: 'denied' }` **before** it writes anything — verified. So a
server-nulled token is never restored by a device whose permission is off; there is no
null/restore loop. That is the property the whole subsystem depends on.

But it currently *only* declines to write — it never clears the token already on the row.
**Add: on `reason === 'denied'`, null `drivers.push_token` and `profiles.push_token` for
that user.** This catches revocation at the next app open, rather than after a wasted push
plus a 15-minute receipt delay.

### 5.3 Server-side: `_shared/push.ts` + a receipt poller

- **`_shared/push.ts`** — one `sendPush`, the `fare.ts`/`presence.ts` pattern. Records
  ticket ids for later polling. Migrating ~13 live sites to it is the bulk of the work.
- **`push_tickets`** table, deliberately minimal:
  ```
  ticket_id   text primary key
  token_sent  text not null      -- the token as sent; null by VALUE, not by user id
  created_at  timestamptz not null default now()
  ```
  **No payload, no user id.** Nulling keys off the token value so it also clears the row of
  a *different* user who happens to hold the same dead token.
- **Poller** — every ~15 min, fetch receipts for tickets older than 15 minutes,
  1000 at a time.
  - `DeviceNotRegistered` → null the token (§5.4).
  - **Delete the row on any successful poll**, plus a sweep for anything older than 24h.
    This is non-negotiable: one row per push send, `scheduled-release` runs every 2 minutes,
    and this project has already had a disk scare from `cron.job_run_details`. Expo drops
    receipts at 24h, so a row older than that is **unpollable by definition** and pure
    waste. Retention goes in the migration, not a follow-up.
  - Piggyback an existing cron rather than registering a new one, per the
    `reap_stale_drivers` precedent.

### 5.4 Null both columns, and only on `DeviceNotRegistered`

`useNotifications` writes the token to **both** `drivers.push_token` (line 72) and
`profiles.push_token` (line 76). Cleanup must clear both, matched **by token value**.

Receipts also return `MessageTooBig`, `MessageRateExceeded`, `MismatchSenderId`, and
`InvalidCredentials`. **Null on `DeviceNotRegistered` alone.** The last two are
platform-wide credential failures — treating them as dead tokens would wipe every push
token on the platform in a single poll. Log the rest; make `InvalidCredentials` and
`MismatchSenderId` **loud**, because they mean nobody on the platform is receiving pushes.

---

## 6. Nulling a driver's token — DECIDED 2026-08-17

Nulling is the phantom-driver problem inverted. `isDriverDispatchable()` requires a token,
so the moment we null it the driver disappears from `assign-ride`, the `scheduled-release`
pool, and every coverage site — while their own app still shows "online" and offers simply
stop arriving. Nothing on the client watches `push_token` the way `DriverApp` watches
`device_token`.

**AGREED: on nulling a driver's token, also set `is_active = false`** when they are not on
an active ride, so the existing go-online gate (which already requires
`registerPushToken()`) becomes the recovery path — reusing machinery we have rather than
building a new signal.

### 6.1 The flip does not currently reach the driver's screen — extra work required

`DriverHomeScreen` reads `is_active` **once on mount** (line 307-311) and has **no realtime
subscription on the `drivers` row**. `DriverApp` has one, but it watches `device_token` for
the single-device lock and does not propagate `is_active` to `DriverHomeScreen`'s
`isOnline` state.

So a server-side flip leaves the toggle showing **"Online"** until the driver restarts the
app — which defeats the entire point of flipping it. **The recovery loop is only closed if
`DriverHomeScreen` subscribes to its own `drivers` row and drives `setIsOnline` off
`is_active`.** Treat that as part of this work, not a follow-up; without it the flip is
invisible and we've swapped a silent phantom for a differently-silent one.

Note the asymmetry with `reap_stale_drivers`: **nulling the token itself is correct even
mid-ride** — the device genuinely cannot receive — but `is_active` must not be flipped on a
driver in `assigned`/`driver_arriving`/`in_progress`. Don't copy the reaper's mid-ride guard
onto the wrong half.

---

## 7. Ordering against G3 §15 — this is why they ship together

§15 gates the reminder SMS on `if (pax?.phone && !pax?.push_token)`. A **stale-but-present**
token means we skip the SMS *and* the push never arrives — the passenger gets nothing.
Today they at least get the SMS.

**So §15 shipped alone is a regression** for any passenger who revoked notifications. This
work must land first, or at minimum together.

One caveat so §15 doesn't get read as fully safe: the recovery is **cross-ride, not
intra-ride**. Expo wants a 15-minute wait before polling and the T-30→T-15 gap is exactly 15
minutes — far too thin to rescue the ride in progress. The value is that the **next** ride's
reminder correctly falls back to SMS.

---

## 8. Scope

- ~13 live send sites. **Dead functions removed from the repo 2026-08-17**
  (`scheduled-lifecycle`, `process-scheduled-rides`, `schedule-rides`,
  `scheduled-ride-reminders`) along with their `config.toml` blocks — 4 of the 17 sites gone.

  **They are still DEPLOYED and ACTIVE**, verified via `supabase functions list`. Two of
  them (`process-scheduled-rides`, `schedule-rides`) run with **`verify_jwt: false`**, i.e.
  they are unauthenticated public endpoints still carrying the *old* scheduled-ride
  dispatch logic against the live database. That is the same exposure class as the `send-sms`
  finding of 2026-08-15. **Undeploying them is a security action, not tidiness** — but
  verify against live `cron.job` first that nothing still calls them, per
  `migration-files-are-not-applied-state`; do not trust this doc for that.
- **A partial redeploy degrades gracefully**: an un-migrated site just fails to null tokens,
  exactly as today. This is *unlike* the `fare.ts` surcharge case where half-applied was
  worse than either end state — no lockstep redeploy needed.


---

## 9. "How do we guarantee a valid token?" — the answer differs by role

Asked 2026-08-17. The two roles need **different guarantees**, and conflating them is what
makes this look harder than it is.

### 9.1 Drivers — push is load-bearing, so gate and recover

A ride offer *is* a push, on a 30-second timer. A driver without a working token cannot be
dispatched, so "online" without one is a lie. The loop, once §6 lands, is closed:

1. Receipt reports `DeviceNotRegistered` → null the token, set `is_active = false`.
2. The driver's screen shows **Offline** (requires §6.1 — it does not today).
3. They tap to go online → `toggleOnline` calls `registerPushToken()` and **refuses** to
   flip `is_active` without a token (`DriverHomeScreen.tsx:337`).
4. If the OS permission was revoked, `registerPushToken` returns `reason: 'denied'` and the
   alert already offers **"Open settings"** → `Linking.openSettings()`
   (`DriverHomeScreen.tsx:349`). This matters because iOS will not re-prompt once denied —
   `requestPermissionsAsync` just returns denied — so a deep link is the *only* recovery.

So "just go online again" is right, **but only because the deep-link path already exists**.
The genuinely missing piece is §6.1, not the gate.

### 9.2 Passengers — you cannot guarantee it, and shouldn't try

There is no passenger equivalent of going online, and there must not be: refusing to let
someone book a taxi because notifications are off is a worse product than a taxi ride with
no push. Guest passengers have no app at all.

**So the requirement is not token *presence*, it is token *accuracy*.** Given an accurate
`push_token` column, G3 §15's `!pax.push_token` gate degrades correctly on its own: token →
push, no token → SMS. The receipt poller is what makes the column accurate; the client-side
null on denied permission (§5.2) is what makes it accurate *fast*. Nothing else is needed —
"always has a valid token" is the wrong goal for this role.

### 9.3 One cadence fix that helps both

`useNotifications` registers **once per session** — `registeredForRef.current === profile.id`
short-circuits every subsequent run. A cold start re-registers, but a foreground resume does
not, so a token that rotates, or a permission re-granted while the app is backgrounded, is
not picked up until the app is killed.

**Re-register on `AppState` → `active`, and write only when the token actually changed.**
The conditional write is what makes this safe: the existing comment at
`useNotifications.ts:99` warns that writing `push_token` to `profiles` triggers the realtime
profile subscription and would loop. Comparing before writing removes that hazard *and*
allows the more frequent check.


---

## 10. Device lifecycle — uninstall, new phone, two phones

Asked 2026-08-17. All three resolve against a **single `push_token` column per user**
(`profiles.push_token`, plus `drivers.push_token` for drivers).

### 10.1 Passenger uninstalls the app

Nothing clears the token — there is no client left to run. The row keeps a token that looks
valid and passes every check.

Recovery is exactly the mechanism this doc exists for: next push → Expo accepts it (ticket
`ok`) → **receipt returns `DeviceNotRegistered`** → poller nulls the token → G3 §15 sees no
token and sends SMS instead. The passenger becomes reachable again automatically.

**Detection is not instant**: it costs one wasted push plus the ~15-minute receipt delay,
and it only happens on the *next* send. Account, ride history and profile are untouched —
they key off the auth user, not the device.

For a **driver**, add the §6 flip: token nulled *and* `is_active = false`, so they stop being
dispatched instead of absorbing offers into a phone that no longer exists.

### 10.2 Passenger changes phones

Self-healing, and faster than the uninstall case: the new phone signs in, `registerPushToken`
runs and **overwrites** `push_token` with the new value. No receipt needed.

**This is precisely why §5.3 nulls by token VALUE and not by user id, and the reason must be
written down or someone will "simplify" it later.** The two events race: the old phone's dead
token can produce a `DeviceNotRegistered` receipt that arrives *after* the new phone has
already registered. Under null-by-user-id that late receipt would wipe the **new, working**
token and silently kill push for a passenger who did nothing wrong. `WHERE push_token =
<old value>` matches nothing, so the new token survives. The value-match is load-bearing,
not a stylistic choice.

### 10.3 Two phones signed in at once

**Passengers have no single-device lock.** `device_token` is drivers-only — `AuthContext`
writes it to `.from("drivers")` (line 136) — so a passenger can be signed in on two devices
simultaneously, by design.

With one token column, **the most recently registered device wins** and the other silently
receives nothing. That is the correct product answer (pushes follow the phone you actually
used), so treat it as designed rather than a bug — but note the consequences:

- The **realtime subscription still works on both phones**, so an open app tracks the ride
  correctly regardless of which holds the token. Consistent with the digest principle: the
  realtime channel is always-correct, push is a nudge.
- The §9.3 foreground re-registration makes ownership **ping-pong** between devices as they
  alternate foreground. Bounded by user action, not a runaway: `useNotifications`' effect
  depends on `profile?.id`, so writing `push_token` does not re-trigger it, and the
  `registeredForRef` guard holds.
- **If multi-device passengers ever matter properly, the real fix is a `push_tokens` child
  table** (one row per device, send to all), not smarter single-column logic. Not needed now;
  recorded so the single column is a known choice rather than an oversight.

**Separate finding:** the same multi-device situation exposes a concurrent-ride race — see
`.claude/notes/concurrent-active-rides.md`. It is independent of this work and blocks
nothing here.


---

## 11. BUILD STATUS — code complete 2026-08-17, NOT yet applied or deployed

Everything below is written and typechecked. **Nothing is live.**

**New:**
- `supabase/migrations/20260753_push_tickets.sql` — `push_tickets` table (RLS on, no
  policies, service-role grants only) + `retire_push_token(text)` SECURITY DEFINER, revoked
  from `public, anon, authenticated` by name.
- `supabase/functions/_shared/push.ts` — the single `sendPush` / `sendPushMany`. Chunks to
  Expo's 100 cap, parks accepted ticket ids, retires ticket-level `DeviceNotRegistered`.
- `supabase/functions/_shared/pushReceipts.ts` — `pollPushReceipts()`: polls receipts older
  than 15 min (1000/batch), retires on `DeviceNotRegistered` **only**, logs
  `MismatchSenderId`/`InvalidCredentials` loudly, deletes resolved rows, sweeps >24h.

**Changed — all 13 live send sites now go through `_shared/push.ts`:** `assign-ride`
(`categoryIdentifier` + `ttl` passed through verbatim — they drive the Accept/Decline
buttons), `dispatch-assign-ride`, `notify-passenger`, `notify-review`, `send-message-push`,
`send-driver-chat-push`, `scheduled-ride-digest` (its watermark still advances only on an
accepted ticket; its hand-rolled batching is gone), `scheduled-release`,
`expire-pending-rides`, `broadcast-scheduled-ride`, `reassign-stale-rides`, `edit-ride`,
`settle-ride`. Zero raw `exp.host` calls remain outside `_shared`.

- `scheduled-coverage-monitor` — calls `pollPushReceipts()` next to `reap_stale_drivers`,
  wrapped so a sweep failure never blocks coverage recomputation. **No new cron.**
- `scheduled-release` — G3 §15 applied: T-30 SMS removed entirely, T-15 SMS gated on
  `!pax.push_token`. GSM-7 single-segment comment moved onto the surviving message.
- `useNotifications.ts` — clears this device's token on denied permission (by VALUE, via an
  AsyncStorage record of what this device last wrote — nulling by user id would wipe a
  second phone's working token); `syncPushToken()` reconciles on `AppState → active`.
- `DriverHomeScreen.tsx` — realtime subscription on its own `drivers` row driving
  `setIsOnline`, so a server-side `is_active` flip is actually visible (§6.1).
- Dead functions deleted: `scheduled-lifecycle`, `process-scheduled-rides`, `schedule-rides`,
  `scheduled-ride-reminders`, plus their `config.toml` blocks.

**Typecheck:** `_shared/push.ts` and `_shared/pushReceipts.ts` clean. Modified functions
carry exactly their pre-existing error count (`assign-ride` + `edit-ride`: 110 at HEAD, 110
now) — all `GenericStringError` inference noise on untyped Supabase queries, none on the push
code. App: 296 errors vs 310 at HEAD (the drop is the deleted dead functions); the 3 in
`useNotifications.ts` are pre-existing.

### Deploy order (nothing here is automatic)

1. **Apply `20260753` in the SQL editor.** Must be first — every function below calls
   `retire_push_token` and writes `push_tickets`.
2. Redeploy all 14 changed functions. Partial redeploy **degrades gracefully** (an
   un-migrated site just fails to null tokens, exactly as today) — unlike the `fare.ts`
   surcharge case, no lockstep is required.
3. **Phase 0 first if reminders matter:** set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
   `TWILIO_FROM_NUMBER`. Still absent as of 2026-08-17 — §15's SMS path cannot fire without
   them, and no reminder SMS has ever sent.
4. App changes need a build to reach devices.
5. **Still deployed and unauthenticated:** the four dead functions are ACTIVE on the project
   (`process-scheduled-rides` and `schedule-rides` with `verify_jwt: false`). Removing them
   from the repo does not undeploy them. Verify live `cron.job` first, then undeploy.

### What to watch after deploy

- `[receipts] polled N, retired N, swept N` in `scheduled-coverage-monitor` logs.
- `[receipts] CREDENTIAL FAILURE` — means nobody on the platform is getting pushes.
- `push_tickets` row count should stay bounded, not grow monotonically.
