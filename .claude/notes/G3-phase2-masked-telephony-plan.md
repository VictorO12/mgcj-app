# G3 Phase 2 — masked voice + SMS (Twilio Proxy)

Status: **IN PROGRESS 2026-08-18.** Design settled; build order below.
Parent doc: `G3-ride-communications-design.md` (§6 telephony, §7 degrade path, §9 scale,
§13 D2). This file is the Phase 2 delta only — it does not restate the parent.

---

## 0. The two facts this plan rests on, and their provenance

1. **Twilio Proxy IS available on this account.** Verified by Victor in the console,
   2026-08-18. The parent doc had `§11 Phase 2` asserting "Proxy is confirmed available
   (§3.2)" while `§3.2` said in as many words that it was *unverified* — an intent written
   down as a state and then cited as its own source. Nobody had looked. §3.2 is now
   corrected. It happened to be right, which is the worst outcome: a coin flip that lands
   your way teaches nothing.
   **This was not cosmetic.** §6.2's schema (`proxy_number` / `passenger_number` /
   `driver_number`, routing keyed on caller+proxy) is the **hand-rolled** table. Building
   it would have committed us to the non-Proxy branch by accident. The schema in §2 below
   supersedes §6.2 for this reason.
2. **Phase 0 was NOT proven when this plan was written.** Confirmed by Victor 2026-08-18:
   no SMS had ever left this platform. Secrets are set; that is not the same thing. See §6.
   **Superseded 2026-08-22: Phase 0 PASSED** — one real SMS delivered end to end. The live
   record is `g3-phase2-setup-and-checks.md` §6; this line is kept for the provenance only.

---

## 1. What Twilio owns vs what we own

Proxy owns the hard parts, which is the whole reason to take the beta risk:

| Concern | Owner |
|---|---|
| Number pool, allocation, `(caller, proxy)` → session routing | **Twilio** |
| Not putting one participant in two live sessions on one number | **Twilio** |
| Area-code matching (`geo_match_level`) | **Twilio** |
| Which ride a session belongs to; who may see a number | **Us** (`ride_contact_sessions`) |
| When a session opens and closes | **Us** |
| Audit / dispute evidence | **Us** |

We keep our own mapping table anyway. Not redundancy: Twilio's session list is not
queryable per-ride at the latency a screen needs, it is not RLS-able, and it disappears
if we ever leave Proxy. The table is the thing that makes the beta risk survivable.

## 2. Schema — supersedes §6.2

`20260756_ride_contact_sessions.sql`.

```
ride_contact_sessions
  id                        uuid pk
  ride_id                   uuid not null → rides(id) on delete cascade
  company_id                uuid              -- stamped by trigger, tenant reporting
  driver_id                 uuid              -- WHICH driver this session is for (see §3)
  proxy_session_sid         text not null     -- KC…
  passenger_participant_sid text              -- KP…
  driver_participant_sid    text              -- KP…
  passenger_number          text not null     -- real, E.164
  driver_number             text not null     -- real, E.164
  passenger_proxy_number    text              -- what the PASSENGER dials
  driver_proxy_number       text              -- what the DRIVER dials
  mode                      text not null default 'voice-and-message'
  allocated_at              timestamptz not null default now()
  released_at               timestamptz       -- null = live
  closed_reason             text
```

Notes that are load-bearing:

- **Two proxy numbers, not one.** Twilio's `Participant.proxy_identifier` is *the number
  that participant dials to reach their partner* — not their caller ID. It is a
  per-participant field, and storing one shared `proxy_number` (as §6.2 did) assumes the
  pair always shares a number. They usually do. Storing what the API actually returns
  costs two columns and removes an assumption we would only discover was wrong in
  production, on a call that failed to connect.
- **No unique constraint** anywhere, per §9 — a partitioned table's unique constraints
  must include the partition key, and adding one now blocks the later conversion. The
  "one live session per ride" rule is enforced by the allocator, not by the schema.
- Partial index `(ride_id) where released_at is null` — the only hot read.
- `driver_number`/`passenger_number` are stored **because the session is the audit
  record**. A dispute six months out needs to say which two numbers were bridged; Twilio's
  retention is not ours to rely on.

## 3. Driver cycling → close and reopen, never participant surgery

Rides change drivers here routinely (`assign-ride` two-pass cycling, `dispatch-assign-ride`,
a released soft claim). Twilio caps a session at **two participants** and participants
**cannot be updated** — swapping means delete-then-create.

**Decision: on a driver change, close the old session and open a new one.** One row per
`(ride, driver)`.

Why not delete-and-re-add the driver participant in place:
- It sidesteps the no-update restriction rather than living with it.
- It gives a real audit trail — "which driver could reach this passenger, between when and
  when" is exactly the dispute question, and a mutated session cannot answer it.
- Closing first also avoids §6.3's one-participant-two-live-sessions-one-number hazard by
  construction.

Cost: a second session. Proxy has **no published per-session fee** — you pay the
underlying number/voice/SMS. That is *unconfirmed* and worth one look at the console
billing page before this ships; if a per-session fee exists this decision is still right,
just no longer free.

## 4. Allocation is webhook-driven, not call-site-driven

A **Database Webhook on `rides` UPDATE → `sync-ride-contact`**, same pattern as
`notify-passenger` and `send-ride-receipt`.

This is the important structural choice. Driver assignment happens in at least four places
(`assign-ride`, `dispatch-assign-ride`, `scheduled-release`'s preferred-driver path, a
claim re-confirmation). Allocating from each of them is four places to forget — and the
one that forgets produces a *hidden call button*, which nobody reports as a bug because it
looks like the feature isn't there yet. The row transition is the single truth; hang off it.

`sync-ride-contact` decides from `old_record` vs `record`:

| Transition | Action |
|---|---|
| `driver_id` null → set, ride contactable | allocate |
| `driver_id` A → B | close A's session (`closed_reason='driver_changed'`), allocate B |
| `driver_id` set → null | close (`'driver_unassigned'`) |
| → `completed` | set Twilio `date_expiry` = `completed_at + 2h`; **do not close now** |
| → `cancelled` | close immediately |

**The grace window is Twilio's `date_expiry`, not a cron of ours.** Setting expiry at
completion makes Twilio enforce the 2h and close the session itself. No new scheduled job,
nothing to 401 silently, and the parent doc's own consistency point holds: chat and phone
die at the same moment.

**The 2h must not be a fourth hardcoded copy.** `ride_accepts_messages()` (SQL) is the
authority and `rideAcceptsMessages()` is its one client mirror — Phase 1's memory is
explicit that a third copy shows up as a button that does nothing. Phase 2 reads the grace
interval from the same place rather than typing `2 hours` again.

**Cancelled rides get no grace**, matching D4 exactly: no `completed_at`, and nothing to
have left in the car.

## 5. Fail closed, everywhere

From §6.3: pool exhausted → **hide the button**. Never reveal a real number, never fall
back to `tel:`. This is the single rule that the whole feature is for, and it is the one
that erodes under a deadline, so it is stated as a client invariant: the buttons render
from the *session*, not from `ride.driver.phone`. If there is no live session there is no
number in the component to leak.

`ride-contact` (client-callable, JWT, participant-gated) returns
`{ can_contact, call_number, sms_number, reason }` for the **calling user's own role**.
A passenger asking never receives the driver's real number and vice versa; the only number
that crosses the wire is a proxy one.

## 6. Phase 0 gates the SMS half — not the voice half

Masked SMS rides on a send path with **zero successful sends in the platform's history**.
That is the exact shape of the `send-sms` 503 incident: a surface built on a channel
nobody had exercised, failing silently for months.

Two distinct risks, and only the first is Twilio-credential-shaped:
1. **Secrets/credentials.** `send-sms` now returns 503 naming the missing secret, so this
   fails loudly. Low risk.
2. **Carrier-level gating.** A2P 10DLC / campaign registration on a long code, or leftover
   trial destination restrictions. This fails *at the carrier*, after Twilio accepts the
   message with a 201 — so `send-sms`'s error path never sees it and the log says success.
   **This is the one that would repeat the incident.** It is checked in the Twilio console
   Messaging → Regulatory/Campaign section, not in our code.

**Sequencing:** voice does not depend on either, so masked voice can ship first. Masked SMS
ships behind one real message observed arriving, plus a look at message *status* in the
Twilio console (`delivered`, not merely `sent` or `accepted`).

## 7. Build order — CODE COMPLETE 2026-08-18, nothing applied or deployed

1. ✅ `20260756_ride_contact_sessions.sql` — table, `expires_at`, interaction counters,
   company-stamp trigger, RLS **deny-all with no grants** (see §5 note below),
   `ride_contact_grace()` / `ride_contact_expiry()`, and a `CREATE OR REPLACE` of
   `ride_accepts_messages()` so the 2h has one SQL definition rather than two.
2. ✅ `_shared/twilioProxy.ts` — session/participant/message-interaction client plus
   `validateTwilioSignature`. Every Proxy concept is confined to this file, so the
   hand-rolled fallback of §6.3 has one seam to swap at if Twilio EOLs the beta.
3. ✅ `sync-ride-contact` — `WEBHOOK_SECRET`-gated, driven by a `rides` UPDATE webhook.
4. ✅ `ride-contact` — client-callable, participant-gated, returns the caller's own
   proxy number only.
5. ✅ `twilio-proxy-callback` — X-Twilio-Signature validated; metadata counters and the
   out-of-session reply. **No recording, ever** (§6.4).
6. ✅ `useRideContact` + call sites — passenger tracking sheet (call + SMS),
   `AssignedRidesListScreen` (per card), **and a new masked-call button on
   `DriverActiveRideScreen`**, which had chat and nothing else. That last one is the
   surface that matters most: a guest passenger with no app cannot be reached by chat at
   all, and this screen is where the driver actually is when they need them.
7. ⏳ Hand-applied — `.claude/notes/g3-phase2-setup-and-checks.md`. Proxy Service,
   number pool, secrets, migration, deploys, the Database Webhook, and an 8-scenario
   live test plan. **None of it done.**

### D2, resolved differently than recommended — confirm this

D2 recommended **removing** the `tel:`/`sms:` buttons at Phase 2, on the grounds that
leaving them meant a driver leaking their real number out of habit.

They are **kept and re-pointed at the masked line** instead, because masking removes the
grounds: there is no real number in those components any more to leak. That is strictly
better than deletion — it keeps the *only* channel that reaches a guest passenger with no
app, which is the population §7 says the telephony half exists for.

**One exception, where removal was the only option:** `AssignedRideScreen`'s call button is
**gone**. That screen is only ever shown pre-acceptance, no line is allocated pre-acceptance
(§4), so the button could only ever have dialled the raw number. Recorded as a deliberate
capability reduction with the one-line fix noted in place — widen `CONTACTABLE`, at the
cost of pool capacity held per outstanding offer.

## 8. What this does NOT close

- **D3 retention.** Floor is the 120-day chargeback window, ceiling is the PIPEDA/lawyer
  question. 180 days proposed. The retention cron is Phase 3's. Do not settle D3 to unblock
  a migration — that is the D4 mistake, and the parent doc records why it was one.
- **Phase 3** — dispatch thread view, retention cron.
- **Account deletion** (§14) — separate work item, and `sender_id`-shaped, not this.
- **The cost model (§10) is still not computed.** Proxy adds no published per-session fee,
  so the shape is: pooled numbers ≈ $1.15/mo each (near-fixed per region, NOT per ride) +
  voice per-minute on **both legs** + SMS per-segment **both directions**. The per-ride
  figure depends on contact rate, which we have no data for. It belongs next to the
  ~$0.42/ride Maps number before this is priced into a pitch.
