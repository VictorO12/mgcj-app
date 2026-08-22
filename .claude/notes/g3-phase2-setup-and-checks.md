# G3 Phase 2 — hand-applied setup, and how to prove each step landed

Nothing in this file is done by code. Per `migration-files-are-not-applied-state`,
every item is exactly the kind that gets believed-but-not-applied — and Phase 2 has
**more** of them than any feature so far, because half of it lives in Twilio's console
rather than in this repo.

Order matters. Steps 1–3 must precede 4, or the functions deploy against nothing.

---

## 1. Twilio console — create the Proxy Service

Proxy → Services → Create.

| Field | Value | Why |
|---|---|---|
| Unique name | `vellon-ride-contact` | no PII (Twilio's rule) |
| Default Time to Live | `0` (seconds) | Twilio: "The default value of `0` indicates an unlimited Session length." We set `DateExpiry` per session at completion; a service-wide TTL would close live rides mid-trip |
| Callback URL | `https://<ref>.supabase.co/functions/v1/twilio-proxy-callback` | interaction metadata |
| Out-of-session callback URL | same URL | the "that ride has ended" reply |
| Geo match level | `area-code` | NS is 902/782; a local-looking number gets answered |
| Number selection | `prefer-sticky` | same number across a ride reads as one conversation |
| **Intercept Callback URL** | **empty** | see below |
| **Chat Instance Sid** | **empty** | see below |

**Do NOT enable any recording option.** §6.4 — never, on any surface, for any reason.

**Intercept Callback URL — leave empty.** The console labels it "an error status code will
prevent the interaction from continuing"; the API docs are narrower — only a **403** blocks,
anything else continues — so it is not the outage hazard the console wording implies. Leave
it empty anyway: it adds a synchronous round-trip to us in front of *every* call and
message, and the only policy it could enforce ("is this ride still contactable") is already
enforced by `DateExpiry` + the out-of-session handler. Remember it exists if a hard per-call
gate is ever needed; do not pay for it on every interaction now.

**Chat Instance Sid — leave empty. This one is a real trap.** It forwards inbound SMS into a
Twilio Chat/Conversations instance instead of leaving it on the SMS leg. Phase 1's chat is
Supabase Broadcast, which Twilio knows nothing about — so setting this forks the masked-SMS
half into a service we never read, and messages look sent and vanish. Documented as a
one-to-one relationship, so it is not a thing to experiment with casually.

Note from Twilio's own service blurb: **a number attached to one Proxy service cannot be
attached to another in the same account.** One more reason the OTP number stays out.

## 2. Buy numbers and add them to the Service's pool

Phone Numbers → Buy → area code 902 (and 782), **Voice + SMS capable**. Add each to the
Proxy Service's number pool.

**Start with 2.** Proxy routes on the pair `(caller's real number, proxy number) → session`,
so 200 concurrent rides between 200 distinct passengers and 200 distinct drivers can all
share **one** number — every pair is unique. Pool size does **not** scale with fleet size or
ride volume, and the intuition that it does is the wrong one to carry into a capacity
conversation.

The constraint only bites when the **same phone number** must be in two live sessions at
once: Twilio cannot then tell which session an inbound dial meant, so the participant add
fails and a second number is what disambiguates it.

That sounds unreachable — a driver has one active ride at a time — and **our own 2h grace
window is what makes it routine.** On completion we do not close the session; we hand
Twilio `DateExpiry = completed_at + 2h` (`sync-ride-contact/index.ts`, the `completed`
branch) so D4's left-a-bag case still works. So ride A's session is still live while that
driver is halfway through ride C.

**Sizing rule: max rides one driver completes inside the grace window, plus one.** At
~20-minute rides that is ~5-6. It is flat — adding companies does not move it; only
shortening ride times or lengthening the grace window does. Shorten the grace to zero and
one number would genuinely serve the whole platform. §6.3.

**Do not reuse the OTP number — settled by evidence 2026-08-22, not by caution.**
`+19029157590` is the **live OTP sender**: it delivered `Your code is 577072` through Messaging
Service `mgcj-app`, so Supabase Auth runs on Programmable SMS over that number, not an isolated
Verify service. An earlier assumption here — "Verify needs no from-number, so any number sitting
there is probably idle" — was **wrong**, and it is recorded because it is the plausible-sounding
version of this that will come back.

What that costs, worst first: **(a)** joining a Proxy service means detaching the number from the
`mgcj-app` Messaging Service, and Supabase appears configured against that Service's SID — detach
it and the Service has no sender, so **every login on the platform stops**, not degrades;
**(b)** a Proxy pool seizes the number's inbound webhooks, so anything else pointed at it stops
behaving as configured; **(c)** out-of-session dials get our spoken "only active during a ride"
reply, and ride calls start arriving from the identity passengers associate with login codes —
the exact number a phishing-aware person is trained to distrust.

This closed off the tempting interim plan of borrowing the OTP number to test masked voice before
the compliance profile clears. Buy dedicated numbers; the wait is the cheaper option.

**Blocker as of 2026-08-22:** buying a number requires a Twilio compliance profile, which was
started as a **Business** profile and cannot be edited or deleted self-serve — a support ticket is
open. If the console offers an **Individual / Sole Proprietor** profile, that path asks for
personal name and home address instead of a business registration number, and Twilio documents it
as being for US/Canada entities without an EIN or Canadian BN. Address must be Canadian, in the
region the 902/782 prefix covers, and **not a PO Box**.

Pool exhaustion **fails closed**: no session, no button, escalate to dispatch. It is not
silent though — `sync-ride-contact` logs `participant add failed (pool exhausted?)` with
Twilio's own error code. Watch for that string; it is the signal to buy another number.

## 3. Secrets — Supabase → Edge Functions → Secrets

```
TWILIO_PROXY_SERVICE_SID   KS…            (from step 1)
TWILIO_WEBHOOK_URL         optional; set ONLY if the function is ever fronted by
                           another host. Twilio signs over the URL it was configured
                           with, so a mismatch fails every callback with a 403.
```
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are already set (verified 2026-08-18).

## 4. Apply the migration, then deploy

```
20260756_ride_contact_sessions.sql        via the SQL editor, as usual
supabase functions deploy sync-ride-contact ride-contact twilio-proxy-callback
```

The migration does a `CREATE OR REPLACE` on **`ride_accepts_messages`** — an existing,
live, Phase-1 function. That is intentional (it now reads the grace interval from
`ride_contact_grace()` instead of restating it) and it is signature-identical, so the
`GRANT EXECUTE ... TO authenticated` from `20260754` survives. Verify it anyway — §7 below.

## 5. Database Webhook — by hand, not SQL

Supabase → Database → Webhooks → Create.

| Field | Value |
|---|---|
| Name | `sync-ride-contact` |
| Table | `rides` |
| Events | **UPDATE only** |
| Type | Supabase Edge Function → `sync-ride-contact` |
| HTTP header | `x-webhook-secret: <WEBHOOK_SECRET>` |

Same shape as `notify-passenger`. **The header is not optional** — the function 401s
without it, and a 401 here presents as "the call button never appears", not as an error.

## 6. Phase 0 — the SMS proof: **PASSED 2026-08-22**

The first SMS ever to leave this platform was delivered on 2026-08-22. Twilio → Monitor →
Logs → Messaging, SID `SM4b8e799b04bcd134bd0905ef7570cd2b`: **Delivered at the Carrier
Network stage**, 1.04s, single GSM-7 segment. All three `TWILIO_*` secrets are set.

**How it was proven, and how to re-prove it later.** Do *not* null a push token to force the
T-15 fallback (`scheduled-release/index.ts:972` gates SMS on `pax?.phone && !pax?.push_token`).
Call the function directly — it is `verify_jwt = false` and gated by `requireServiceRole`, so
`x-internal-key` alone gets in:

```bash
curl -i -X POST 'https://hhsqwmftrrmtodvvuyxq.supabase.co/functions/v1/send-sms' \
  -H 'Content-Type: application/json' \
  -H 'x-internal-key: <INTERNAL_API_KEY>' \
  -d '{"phone":"+1902XXXXXXX","message":"Vellon test - your ride is at 3:45 PM. Be ready at 12 Main St - your driver is on the way shortly."}'
```

Send a realistic body, not `"test"` — segment count and content shape are both things carriers
filter on. `INTERNAL_API_KEY` is not in the repo (`20260749` ships the placeholder); recover it
from `cron.job.command`, where `20260749` wrote it in plaintext. Do not rotate it casually: four
cron jobs carry it in their headers and would 401 silently.

**What the pass covers and what it does not.** It proves the code path, credentials, from-number
and GSM-7 segmentation, and it proves the carrier delivers — the half that fails invisibly. It
does **not** prove `scheduled-release` wires the call up correctly on a real T-15; that is still
only proven by a real reminder.

**Two findings from the test worth keeping:**

1. **A bare `From:` number delivers.** The delivered message shows `Message Service: None`.
   A hypothesis that `send-sms` needed to send `MessagingServiceSid` instead of `From:`
   (`send-sms/index.ts:99`) was raised and disproven here. Do not "fix" it in that direction.
2. **`+19029157590` is the live OTP sender** — it sent `Your code is 577072` through Messaging
   Service `mgcj-app`. Supabase Auth is on Programmable SMS, not an isolated Verify service.
   See §2 for why that forecloses reusing it as an interim Proxy number.

The original risk framing, kept because it is what to re-check after any Twilio account change:
credentials fail **loudly** (503 naming the missing secret), carrier gating fails **silently**
(Twilio returns 201, the carrier drops it, our error path never fires, the log says success).
`sent` and `accepted` are not proof — they are the states a carrier-blocked message sits in.
Only `delivered` counts. That silent shape is the 2026-08-15 incident repeating.

---

## 7. Verification SQL — run after step 4

```sql
-- (a) The table, and that it has NO grants to authenticated.
--     A row coming back from the second query is a LEAK, not a success: every
--     row holds both parties' real numbers, and RLS gates rows, not columns.
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'ride_contact_sessions' ORDER BY ordinal_position;

SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'ride_contact_sessions' AND grantee IN ('authenticated','anon');
-- EXPECT: zero rows.

-- (b) RLS on with no policies = deny-all.
SELECT relrowsecurity FROM pg_class WHERE relname = 'ride_contact_sessions';  -- t
SELECT count(*) FROM pg_policies WHERE tablename = 'ride_contact_sessions';   -- 0

-- (c) The grace interval now has ONE definition, and the Phase 1 authority reads it.
SELECT public.ride_contact_grace();                    -- 02:00:00
SELECT prosrc LIKE '%ride_contact_grace%' AS reads_shared_grace
  FROM pg_proc WHERE proname = 'ride_accepts_messages';-- t

-- (d) ride_accepts_messages kept its grant across the CREATE OR REPLACE.
--     If this is false, Phase 1 chat breaks — the composer closes for everyone.
SELECT has_function_privilege('authenticated', 'public.ride_accepts_messages(uuid)', 'EXECUTE');

-- (e) Expiry helper behaves: NULL while live, +2h on completion, now() on cancel.
SELECT id, status, completed_at, public.ride_contact_expiry(id) AS expiry
  FROM rides
 WHERE status IN ('in_progress','completed','cancelled')
 ORDER BY created_at DESC LIMIT 5;
```

---

## 8. Live test plan — scenarios, not units

Run in this order; each builds on the last.

**S1 — the line opens.** Book a ride, let a driver accept it (status → `assigned`).
```sql
SELECT proxy_session_sid, passenger_proxy_number, driver_proxy_number, allocated_at
  FROM ride_contact_sessions WHERE ride_id = '<id>';
```
Both proxy numbers non-null. Call button appears on the passenger tracking sheet **and**
in the driver's collapsed sheet strip.

**S1b — a GUEST passenger can resolve the line. Run this before trusting S2/S3.**
`ride-contact` authenticates with `supabase.auth.getUser(token)`, which is a *different*
check from Phase 1's path (RLS + `is_ride_participant` as `authenticated`). Anonymous
guest bookers sign in via `signInAnonymously()` and `useAuth` deliberately ignores those
sessions — so "does a guest's tracking sheet hold a token `getUser` accepts, and does
`ride.passenger_id` equal that user id" is genuinely unexercised, and it is the one
population this feature exists for.

Book as a guest (no account), get a driver to accept, and confirm the call button appears.
If it does not, the passenger half of the masked line is dead for exactly the users §7 was
written about — **and it fails as a missing button, indistinguishable from "no driver
yet"**. Check the `ride-contact` logs for a 401/403 rather than guessing from the UI.

Note guest profile ids migrate on OTP verification, so also re-check after a guest
registers mid-ride if that flow is reachable.

**S2 — it is actually masked.** Passenger taps call. The driver's handset must ring showing
the **proxy** number, never the passenger's. Then the reverse. *This is the acceptance test
for the entire feature* — if either handset shows a real number, stop and do not ship.

**S3 — masked SMS reaches a guest.** Have dispatch book a ride for a phone number with no
app installed, accept it as a driver, and text from the driver's handset. The guest replies
to the proxy number and the driver receives it. **This is the case Phase 1 could not serve
at all** and the strongest argument for the whole telephony half. Blocked on §6.

**S4 — driver cycling closes the old line.** Reassign a live ride via the dashboard.
```sql
SELECT driver_id, closed_reason, allocated_at, released_at
  FROM ride_contact_sessions WHERE ride_id = '<id>' ORDER BY allocated_at;
```
Expect **two rows**: the first released with `driver_changed`, a second live for the new
driver. Then confirm the **old** driver's number no longer connects — that is the half that
matters, and the half a schema check cannot prove.

**S5 — the window closes with the chat window.** Complete a ride. `expires_at` is stamped
`completed_at + 2h` and the Twilio session shows that `DateExpiry`. Both the call button and
the chat composer must survive to the same moment and die at the same moment; a phone line
outliving the thread is a number still reachable after the product says contact is over.

**S6 — out of session.** After the 2h elapses, dial the proxy number. Expect the spoken
"this number is only active during a ride" message, not a ring-out and not a connection.

**S7 — cancelled gets no grace.** Cancel a live ride. `released_at` is set immediately with
`ride_cancelled`, and the number stops working at once. D4: no `completed_at`, nothing left
in the car.

**S8 — fail closed.** Hardest to stage; worth staging. Temporarily remove every number from
the Proxy pool, then accept a ride. Expect: no session row, no button on either side, and
the pool-exhaustion line in the `sync-ride-contact` logs. **What must NOT happen is a real
number appearing anywhere.**

---

## 9. Things that will look like bugs and are not

- **No call button before the driver accepts.** Deliberate — no line exists pre-acceptance,
  and `AssignedRideScreen`'s call button was removed rather than masked. See the comment
  there for the reasoning and the one-line fix if it turns out to matter.
- **The call button is present during the 2h after completion.** Intended — D4, and the
  same window as chat. It was briefly broken during the build: the hook's pre-flight skip
  treated `completed` as never-contactable and hid the button for the whole grace window
  with no error. Fixed by narrowing the skip; noted here because the symptom is invisible.
- **The button takes a moment to appear.** It resolves over one function call, and the
  webhook allocation races the driver's accept. It self-corrects on the next status change.
- **`sms:` and `tel:` still appear in `HelpSupportScreen` and `RideProblemModal`.** Those
  are the *company's own* dispatch number, not a counterparty's — out of scope for G3, and
  separately tracked as placeholder 555 numbers.
