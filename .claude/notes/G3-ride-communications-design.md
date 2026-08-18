# G3 — Passenger ↔ Driver Communications

Design doc. Nothing built yet. Supersedes the "extend driver_chat_messages to the ride"
one-liner in the review-gap queue, which understated the job.

Status: **design, not approved.** Open decisions at the bottom.

---

## 1. The problem

Today passenger↔driver contact is native SMS + native phone call
(`RideTrackingSheet.tsx:105,111` passenger side; `AssignedRideScreen.tsx:166` and
`AssignedRidesListScreen.tsx:443` driver side). Every one of those exposes both parties'
real phone numbers, permanently, with no way to revoke after the ride.

Two specific failures from the competitor teardown:

- **KAM-i011** — international passenger number. `sms:` either silently fails or bills the
  driver international rates. Nobody finds out until the pickup fails.
- **CAS-a052** — deaf rider. A phone call is not a channel they can use, and it is the
  only channel we escalate to when SMS goes unanswered.

Both are structural, not bugs. Neither is fixable inside the `tel:`/`sms:` model.

---

## 2. What the Uber model actually is

Worth naming precisely, because "add a chat" only covers a third of it:

1. **In-app chat**, ride-scoped, dies with the ride.
2. **Masked voice** through a relay number, so tapping "call" never reveals a real number.
3. **Masked SMS** to the same relay, which is what reaches a passenger with no app.
4. **Driver-safety affordances** — canned quick replies, text-to-speech read-aloud, and
   tap-to-acknowledge (thumbs-up), so a driver never types while moving.

(3) is the part that is easy to skip and is the one that matters most for us — see §7.

---

## 3. Findings that change the plan

### 3.1 Twilio is upgraded but the platform side is completely unwired

`npx supabase secrets list` returns **no `TWILIO_*` secret of any kind** — no account SID,
no auth token, no from-number. So:

- `send-sms` still returns its 503. **No T-30/T-15 reminder has ever sent, and still can't
  today.** The account upgrade did not change this.
- OTP keeps working because Twilio Verify is configured in **Supabase Auth's phone
  provider**, which is a different config surface entirely from Edge Function secrets.
  The fact that OTP works is not evidence that anything else will.

**Precondition for every telephony item below:** set the secrets, then fire one real T-30
reminder end-to-end and watch it arrive. That is a 10-minute task, it is independent of
this feature, and it unblocks a reminder path that has been silently dead since launch.
Do it first, on its own.

### 3.2 Twilio Proxy is Public Beta with no SLA

Verbatim from Twilio's docs:

> "Twilio's Proxy API is currently available as a Public Beta product. Some features are
> not yet implemented and others may be changed before the product is declared as
> Generally Available." … "Public Beta products are not covered by a Twilio SLA."

A search summary also claimed Proxy is **closed to new customers**. I could not verify
that — it is not on the docs page and not in the twilio-labs repo. **Treat it as
unverified.**

**This is the fork in the voice design and it is answerable in 30 seconds:** open Victor's
Twilio console and look for Proxy.

- **Proxy available** → sessions, participants, and number-pool management are handled for
  us. Days of work. Cost: a no-SLA beta underneath a channel we'd be selling into a B2B
  SLA.
- **Proxy absent** → hand-rolled pool + mapping on Programmable Voice (§6.3). Weeks of
  work, but it is ours, has a real SLA under it, and does not evaporate if Twilio retires
  the beta.

Do not build against Proxy on the assumption it's there.

### 3.3 Realtime — don't put this table in the publication

Confirmed from Supabase docs: Postgres Changes "are also processed on a single thread to
preserve their order, which means larger compute add-ons don't meaningfully increase
Postgres Changes throughput."

What the docs do **not** say, and I could not confirm: whether that single thread is shared
across all tables in the `supabase_realtime` publication. **Inferred, not verified.** If it
is shared, adding our highest-write table to a publication that already carries `rides`
means chat inserts contend with the ride status changes that dispatch and passenger
tracking depend on — head-of-line blocking on the most latency-critical path in the system.

Note the *fan-out* argument does not apply here: Supabase's "~3,000 concurrent subscribers"
threshold is about subscribers on the same change, and a ride thread has exactly two
participants. Don't justify Broadcast on fan-out; justify it on not adding a high-write
table to the shared single-threaded publication, plus Broadcast's ability to pick columns
and target specific actions.

**Decision: `ride_messages` uses Broadcast from the database** (trigger → `realtime.send()`
→ private channel). `driver_chat_messages` stays on `postgres_changes` — it is low-volume
and works; no reason to churn it.

---

## 4. Data model

Ride-scoped, not a persistent thread. That is the main departure from
`driver_chat_messages`, and it's deliberate: a passenger↔driver relationship exists only
for the duration of one ride, and should not accumulate history across rides the way
dispatch↔driver does.

```
ride_messages
  id           uuid pk
  ride_id      uuid not null → rides(id) on delete cascade
  company_id   uuid not null → companies(id)      -- trigger-stamped, never client-set
  sender_id    uuid          → profiles(id) ON DELETE SET NULL   -- see note below
  sender_role  text not null check in ('passenger','driver','admin')
  body         text not null
  kind         text not null default 'text' check in ('text','quick_reply','ack')
  created_at   timestamptz not null default now()

  index (ride_id, created_at)                      -- the only access pattern
```

```
ride_chat_reads
  ride_id      uuid not null → rides(id)    ON DELETE CASCADE
  profile_id   uuid not null → profiles(id) ON DELETE CASCADE
  last_read_at timestamptz not null default '1970-01-01'
  primary key (ride_id, profile_id)
```

**Why not one table** (asked 2026-08-17): an append-only log and a mutable cursor have
opposite grant requirements. Per-message `read_at` needs an UPDATE grant on
`ride_messages`, which destroys the free immutability we get from withholding it, forces a
guard trigger to freeze `body`/`sender_id`/`sender_role`, and writes N rows per thread-open
on the highest-write table in the system. That is more machinery, not less.

The awkwardness in the first draft was real, but it was the *shape* of the state table, not
the count. `driver_chat_state`'s two hardcoded columns (`last_read_by_driver_at`,
`last_read_by_admin_at`) are what don't extend — **one row per reader** does, which is what
makes D5 free: an admin opening the thread just gets a row. No CHECK migration, no schema
change. It also removes the contention of two parties upserting the same row.

**`ride_chat_reads` is a read cursor, not a participant list.** It is named for the cursor
deliberately — the next reader must not treat it as the authority on who is in the thread.
Authority stays `is_ride_participant()` reading `rides` live. There is no `role` column for
the same reason: role is derivable from `rides.passenger_id`/`driver_id`, and storing it
duplicates state that can drift.

Note `profile_id` is `ON DELETE CASCADE`, **not** `SET NULL` — it is half the primary key.
This differs from `ride_messages.sender_id` on purpose; don't copy the action across.

Notes:

- **Read state does not go on `rides`.** That table carries the fare/coordinate freeze
  triggers and a passenger UPDATE policy; widening what a passenger may write there to add
  a read timestamp is exactly the wrong trade.
- **No UPDATE or DELETE grant on `ride_messages`.** Immutability falls out of the missing
  grant — no guard trigger needed, unlike the fare columns.
- `kind` distinguishes a tapped quick reply / thumbs-up ack from typed text. Cheap now,
  and it's what makes "driver never typed while moving" auditable later.
- **`sender_id` is nullable with `ON DELETE SET NULL`, and this is load-bearing.**
  `delete-account` detaches `rides`/`ride_reviews` by nulling `passenger_id` and then
  **explicitly deletes the `profiles` row** (`delete-account/index.ts:64-65`). A
  `NOT NULL` FK to `profiles` would raise a violation and break passenger self-deletion —
  a shipped, working flow — the moment this table holds a row for a deleting passenger.
  `sender_role` carries the attribution needed to render the thread, so the id isn't
  required after the fact. `driver_chat_messages` has the unsafe shape and escapes it only
  because drivers never self-delete; don't copy it.
- **`sender_role`'s CHECK includes `'admin'` from day one though nothing writes it** — see
  D5. Widening a CHECK later is another hand-applied migration, and this repo's history
  says those get believed-but-not-applied. One word now beats an ALTER later.

---

## 5. RLS

**Authority is the `rides` row, not `company_id`.** Copying
`company_id = get_my_company_id()` from the driver-chat policies would be wrong here:
anonymous guest bookers are a real population and that column is not what makes them a
participant.

- Participation resolves through a **`SECURITY DEFINER` plpgsql helper**
  (`is_ride_participant(ride_id)`), not a raw cross-table subquery from `ride_messages`
  into `rides` — that subquery is the 42P17 recursion shape we've already been bitten by.
  Unlike `reap_stale_drivers`, this helper **needs** `EXECUTE` for `authenticated`;
  anonymous sign-in yields role `authenticated`, so guests are covered by it.
- **SELECT stays open to participants forever.** Status gates INSERT only. Putting status
  into the SELECT policy makes the thread vanish under both parties the instant the driver
  taps complete — and the thread is the evidence when the ride gets disputed.
- **INSERT gated on `status IN ('assigned','driver_arriving','in_progress')`.**
  Verified sound: `assign-ride` only ever writes `status: 'offered'` (line 484), and every
  path that writes `'assigned'` sets `confirmed_by_driver: true` in the same statement
  (`AssignedRideScreen.tsx:81`, `DriverApp.tsx:545`, `:589`). `dispatch-assign-ride` writes
  `'offered'`/`'scheduled'` with `confirmed_by_driver: false` (line 113-114). So `assigned`
  implies confirmed, and no separate confirmed check is needed. **Re-verify if anyone adds
  a new writer of `'assigned'`.**
- **`sender_role` is verified against the ride, never self-asserted:**
  `sender_id = auth.uid()` AND (`'passenger'` ↔ `ride.passenger_id = auth.uid()`)
  OR (`'driver'` ↔ `ride.driver_id = auth.uid()`). Without this the passenger can post as
  the driver — the same bug class `20260702_driver_chat_tenant_fix.sql` fixed.
- **`company_id` stamped by a BEFORE INSERT trigger** from the ride.
- **Admin SELECT policy included in this migration** even though no dashboard UI is planned
  in phase 1 — adding a policy later is another hand-applied migration, and dispatch
  needs the thread when adjudicating a complaint. (Open decision D1.)

---

## 6. Telephony

### 6.1 Principle

Neither party ever sees the other's real number, and the relay stops working after the
ride. This is the whole point; a design that leaks the number in any fallback path has
failed.

### 6.2 Allocation lifecycle

**Allocate the proxy number at driver assignment, not lazily on first call.** Inbound
routing keys off `(caller's real number, proxy number)` — the mapping must already exist
when the call arrives or there is nothing to match it against. Release on ride completion
plus a grace window (proposal: 2h, covers "left my bag in the car").

```
ride_contact_sessions
  id                uuid pk
  ride_id           uuid not null → rides(id)
  proxy_number      text not null            -- E.164
  passenger_number  text not null
  driver_number     text not null
  allocated_at      timestamptz not null default now()
  released_at       timestamptz              -- null = live
  index (proxy_number, released_at) where released_at is null
```

### 6.3 Pool sizing and sharing

The constraint, from Twilio's own guidance: a participant cannot be in two concurrent
sessions on the same proxy number, and there is no fixed session-per-number cap — "the
limiting factor … is phone number reputation and messaging compliance status, not a fixed
session count," with US/Canada numbers sustaining high concurrency.

Two consequences:

- **One pool shared across all companies**, not a pool per company. Since the routing key
  includes the caller's real number, a single proxy number serves many concurrent sessions
  as long as no participant repeats on it. Per-company pools would multiply cost for no
  isolation benefit — and tenant isolation here is enforced by the mapping table, not by
  number ownership.
- **Area code matters if we want local-looking numbers.** Twilio: "A service with
  participants spread across 20 area codes requires at least 20 numbers." Nova Scotia is
  902/782, so the Valley launch needs very few. Canada-wide expansion is a
  numbers-per-region cost, and that is the line item that grows, not the code.

Allocation picks a number with no live session for either participant. If the pool is
exhausted, the correct behaviour is to **fail closed** — hide the call button — never to
fall back to the real number.

### 6.4 No call recording

Metadata only (who, when, how long, which SID). Twilio's own Proxy docs flag consulting
legal counsel about laws governing recording user communications; two-party-consent rules
vary by province and recording would open a compliance surface far larger than this
feature justifies. Uber doesn't record either. **Decision: never record.**

---

## 7. The degrade path — and why telephony is the point

Dispatch creates **guest profiles for unregistered passengers keyed by phone number**.
Those passengers are not on the app at all. In-app chat structurally cannot reach them.

Earlier I'd closed this with "hide chat, keep `tel:`" — that was wrong, and Twilio being
live is what makes it wrong. The right answer:

| Passenger state | Channel |
|---|---|
| App installed, push token present | In-app chat (primary), masked voice |
| App installed, no/stale push token | In-app chat still works — realtime thread is the channel, push is only a nudge |
| Guest profile, no app | **Masked SMS** + masked voice |
| Pool exhausted / telephony down | No contact button. Escalate to dispatch. Never reveal a real number. |

**Masked SMS is the documented degrade, not a hidden button.** It is the only channel that
reaches the app-less population, and it is the strongest single argument for doing the
telephony half at all.

Note this also means the realtime thread — not the push — is the always-correct channel,
same argument as the digest. The `DeviceNotRegistered` stale-token blocker is still open,
so nothing here may assume a push landed.

---

## 8. Driver safety UX

Non-negotiable, and it is most of what Uber's driver surface actually is:

- **Canned quick replies** — "Outside", "2 minutes", "Can't find you", "On my way".
  Written as `kind='quick_reply'`.
- **Read-aloud** incoming messages via TTS (`expo-speech`), so the driver's eyes stay up.
- **Tap-to-acknowledge** thumbs-up, written as `kind='ack'`.
- **Suppress the free-text keyboard while `in_progress`** — quick replies only. Typing
  while driving is the thing we're designing out.
- **The driver now has two threads.** `DriverChatScreen` is dispatch. A ride thread with
  the same 💬 icon will be confused with it. Distinct icon, distinct label, and a distinct
  push title — `send-driver-chat-push` uses "💬 Message from dispatch", so the new one must
  not read like that.

---

## 9. Scale — build partition-ready, don't partition yet

Two companies in the Annapolis Valley, on a free tier that already had a 2GB scare from
`cron.job_run_details`. Designing today for Casino Taxi's 1.8M rides/yr buys nothing and
costs a hand-applied migration.

**Build now:**
- Schema that can be converted to declarative partitioning later — `created_at` usable as a
  partition key, and **no unique constraint that would block conversion** (a partitioned
  table's unique constraints must include the partition key).
- A **nightly retention cron** modelled on `cleanup-cron-logs`: delete `ride_messages` and
  released `ride_contact_sessions` older than the retention window.

**Defer, with a note:** actual declarative partitioning, and archival to cold storage.

**Retention has a floor and a ceiling, and they come from different places** — this is the
correction to an earlier "90 days" proposal, which was a round number rather than a derived
one:

- **Floor = the chargeback window.** Card networks let a cardholder file up to **120 days
  from the transaction date** (longer in some Visa future-delivery cases). §5 justifies
  SELECT-forever on the grounds that the thread is dispute evidence — deleting at 90 days
  means a dispute landing on day 100 finds that evidence gone, against a platform that has
  a whole apparatus around this (`dispute_won_at`, the never-refunded $15 fee, the
  vellon-ops refund flow). **A 90-day purge is actively wrong.** Floor: 120 days minimum,
  and worth confirming against Stripe's own CA card-not-present numbers.
- **Ceiling = PIPEDA data minimisation.** This is the lawyer question, and it is a
  different input from the floor.

Proposal: **180 days**, comfortably clear of the filing window with room for the response
deadline, pending the legal ceiling.

---

## 10. Cost

Belongs in the model next to the ~$0.42/ride Maps figure, and it will come up in a pitch:

- Numbers: ~$1.15/number/month. Pool-sized, so it's near-fixed per region, not per ride.
- Voice: per-minute, both legs (inbound to proxy + outbound to the real party).
- SMS: per-segment, both directions.

Against a 6–8% take rate. Worth computing a per-ride figure before committing, and worth
knowing which way it moves when a company runs high no-contact volume. **Not yet modelled.**

---

## 11. Proposed build order

Each phase is independently shippable.

- **Phase 0** — **HALF DONE 2026-08-17.** `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
  `TWILIO_FROM_NUMBER` are set and verified present. **The end-to-end send is still
  unproven** — no SMS has ever left this platform, so "secrets exist" is not the same as
  "SMS works".
  Note the original wording ("verify one real T-30 reminder") is now obsolete: §15 removed
  the T-30 SMS entirely. The check is now **one real T-15 SMS to a passenger with no
  `push_token`**, since that gate is the only path that sends. Watch `scheduled-release`
  logs for it — `send-sms` returns 503 naming missing secrets rather than a silent 200, so
  a failure will be visible.
  *Not part of this feature. Do it regardless.*
- **Phase 1** — NOT STARTED. `ride_messages` + `ride_chat_reads`, RLS, Broadcast trigger, passenger and
  driver thread UI, `send-ride-chat-push`. Quick replies + read-aloud + ack included; they
  are not polish. Ships value alone and closes CAS-a052.
  **Spike first (half a day):** Broadcast's private-channel authorization runs as RLS on
  `realtime.messages`, keyed on topic name. Confirm `is_ride_participant()` is callable in
  that context and that the ride id can be extracted from the topic. This is the one piece
  of the design with **no precedent in this repo** — `driver_chat_messages` uses
  `postgres_changes`, so hand-applied step 5 is new ground. If it doesn't work cleanly the
  fallback is `postgres_changes` with a `ride_id=eq.X` filter and Phase 1 doesn't change
  shape — but find out before estimating, not mid-build.
- **Phase 2** — NOT STARTED. Proxy is confirmed available (§3.2), so this is the Proxy
  path: masked voice + masked SMS, behind our own `ride_contact_sessions` mapping table. Closes KAM-i011 and the guest-passenger gap. Only after
  this may the `tel:`/`sms:` call sites be removed.
- **Phase 3** — NOT STARTED. Dispatch-side thread view; retention cron.

**G3 is not closed until Phase 2 lands** and those four `tel:`/`sms:` call sites are gone.
Phase 1 alone leaves number exposure exactly where it is.

---

## 12. Hand-applied steps (not code)

Per `migration-files-are-not-applied-state` — these are easy to believe are done:

1. Migration applied via SQL editor: tables, GRANTs (post-Oct-2026 rule), RLS policies,
   `is_ride_participant` helper + its `EXECUTE` grant to `authenticated`, company-stamp
   trigger, Broadcast trigger.
2. **Database Webhook created by hand in the Supabase dashboard** for `send-ride-chat-push`
   — same as `notify-dispatch-report`. Not SQL.
3. Twilio secrets set in Edge Function config.
4. Twilio numbers purchased; voice/SMS webhooks pointed at our function.
5. Realtime authorization for the private channel (`realtime.messages` RLS).

---

## 13. Open decisions

- **D1 — Do admins get SELECT on ride threads?** Recommend **yes**, policy included in the
  phase-1 migration even with no UI, so the later addition isn't another hand-applied
  migration. Counter-argument: passenger↔driver messages may carry an expectation of
  privacy from dispatch that a chat with a taxi company's staff does not.
- **D2 — Does chat replace the SMS button or sit beside it?** Recommend **replace, at
  Phase 2**. Leaving both means the driver leaks their number out of habit. But it can only
  be removed once masked SMS exists, or guest passengers lose contact entirely.
- **D3 — Retention window.** Floor is the 120-day chargeback filing window, *not* a round
  number; ceiling is PIPEDA minimisation and is the lawyer's question. **180 days**
  proposed. See §9.
- **D4 — Grace window after completion.** 2h proposed for both thread INSERT and proxy
  release.
- **D5 — Does dispatch get a third leg** (dispatch↔passenger)? Out of scope for the build,
  but pre-empted in the schema: `sender_role`'s CHECK already admits `'admin'` (§4) so
  adding the leg later needs no CHECK migration. Still worth deciding whether it's wanted,
  since it affects whether D1's admin SELECT is read-only or read-write.

