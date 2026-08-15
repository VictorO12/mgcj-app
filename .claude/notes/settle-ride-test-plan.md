# settle-ride — live test plan (2026-08-13)

Migration `20260741` + `settle-ride`, `capture-payment`, `expire-pending-rides`,
`scheduled-release` are deployed. The mobile changes run from Expo Go (local
code). **The dashboard change is NOT deployed** — see Blocker below.

## Pass/fail signal

`rides.payment_status` is NOT a valid signal. `releaseHold` returns
`{ok:true, released:false}` when the PI is missing or in an unexpected state,
and the caller still writes `payment_status:'unpaid'` whenever a PI id exists —
so the DB row reads identically whether the hold was released or silently
skipped.

Assert on two things instead:
- the settle-ride response body's `hold_released: true`
- the PaymentIntent at Stripe: `status: "canceled"`
  (`stripe login` then `stripe payment_intents retrieve pi_...`, or the sandbox
  dashboard)

## Blocker — dashboard is uncommitted

`mgcj-dashboard/src/pages/DashboardPage.tsx` is modified but not committed or
pushed. Vercel therefore still serves the OLD dispatch cancel, a bare
`.update({status:'cancelled'})` that never touches Stripe. Sweep A will quietly
clean up the stranded hold on the next cron tick, so **test 3 would look like it
passed while testing nothing**.

Either run the dashboard locally (`npm run dev`) for test 3, or push first.

## Shortcuts (SQL editor)

Direct DB access has no JWT, so `auth.role()` is NULL and the lifecycle guard
lets these through by design.

```sql
-- skip the real 5-minute no-show wait
update rides set arrived_at = now() - interval '6 minutes' where id = '<ride>';

-- age a ride into Sweep C's fuse
update rides set assigned_at = now() - interval '7 hours',
                 arrived_at  = now() - interval '7 hours' where id = '<ride>';

-- watch a ride
select id, status, payment_method, payment_status, payment_check_status,
       payment_check_attempts, payment_check_last_code,
       assigned_at, arrived_at, cancelled_at, cancelled_from_status,
       no_show_at, cancelled_reason, stripe_payment_intent_id
from rides where id = '<ride>';
```

Book the pickup at your own coordinates so the 150 m no-show check can pass.

## Order

### 0. Regression smoke — run these first

The guard trigger does **not** exempt admins. I checked both repos: every
`rides` update sends a narrow field set, so it should not false-fire. Confirm
live anyway, because the failure mode is a dispatch outage:

- **0a** Dispatch: open an `assigned` ride, edit the address or fare, save.
  Must succeed. A `Ride lifecycle/payment-check fields are server-owned` error
  here = stop, the guard is too tight.
- **0b** Driver: advance a ride `assigned → driver_arriving → in_progress →
  completed`. Must succeed at every step. Then check `assigned_at` and
  `arrived_at` got stamped.
- **0c** Full happy-path card ride, end to end, captured. Nothing below matters
  if the normal path broke.

### 1. Passenger cancel, scheduled card ride
Book scheduled + card, wait for the hold, cancel from ScheduledRidesScreen.
→ `hold_released: true`, PI `canceled`, `cancelled_reason: 'passenger_cancelled'`,
  `cancelled_at` set, `cancelled_from_status: 'scheduled'`.

### 2. Passenger cancel, active ride
Same, from PassengerHomeScreen on an `assigned` ride.
→ driver gets the "passenger cancelled" push.

### 3. Dispatch cancel  ← needs the dashboard blocker resolved
→ passenger AND driver both pushed.

### 4. driver_release on a FUTURE scheduled ride
This is the one with no other safety net — it was a bug I fixed on review and
nothing else catches it.

Dispatch-assign a driver to a ride scheduled 3+ hours out, driver accepts it,
then open **Assigned rides → the scheduled card → Release** (added 2026-08-13;
the in-ride Release button on DriverActiveRideScreen is unreachable for a
future scheduled ride, so the list card is the only real path).

Routing: **any confirmed scheduled ride goes to `settle-ride`**, whatever its
status. `decline-assigned-ride` is kept only for its actual contract
(unconfirmed AND status `scheduled`) — it 409s on `confirmed_by_driver` and on
any other status, so it can't serve a Release.

Worth hitting all three statuses a confirmed scheduled ride can sit at, since
they arrive by different routes and all now hit `driver_release`:
- `scheduled` — accepted from the list (accept only sets `confirmed_by_driver`)
- `offered` — preferred-driver offer accepted from the list
- `assigned` — preferred-driver offer accepted from `AssignedRideScreen`
→ status must return to **`scheduled`**, NOT `pending`. `driver_id` null,
  driver appended to `declined_by`, hold untouched (PI still
  `requires_capture`), passenger keeps their booking and gets no cancellation.

Then repeat on an immediate ride → status `pending` and assign-ride re-runs.

**Also check the countdown card clears.** A confirmed scheduled ride is
DriverApp's `activeRide`; releasing it now fires `onReleased` → `fetchActiveRide`
→ `setActiveRide(null)`. Close the list after releasing — DriverHomeScreen must
NOT still show the countdown card or a live "Start ride" for that ride.
(Realtime can't cover this: the row's `driver_id` goes null, so the
`driver_id=eq.<me>` subscription filter stops matching it.)

### 5. no_show gates
On a `driver_arriving` ride:
- **5a** tap immediately → 409, "Please wait at least 5 minutes at the pickup
  before reporting a no-show — about N more minutes." If you see "Edge Function
  returned a non-2xx status code" instead, the client isn't unwrapping the error
  body (fixed 2026-08-13 via `lib/invokeFunction.ts`; supabase-js hides the JSON
  body of any non-2xx behind `error.context`).
- **5b** drive a few blocks away, backdate `arrived_at`, tap → 409,
  "need to be at the pickup".
- **5c** at the pickup, backdated → succeeds. PI `canceled`, `no_show_at` set,
  `cancelled_reason: 'passenger_no_show'`, passenger pushed "you have not been
  charged". **No fee charged** — confirm nothing was captured.
- **5d** driver's `is_active` stays true and they're immediately dispatchable
  again. This is the fleet-availability bug the whole thing exists for.

### 6. Idempotency
The UI can't produce a second cancel (the ride leaves the list), so call the
function directly — twice, as `!curl` so the key stays out of the transcript —
against a ride already cancelled through the UI in test 1 or 2:

**Use the `sb_secret_...` key, not the legacy `service_role` JWT.** The
functions' `SUPABASE_SERVICE_ROLE_KEY` is the new-format secret key, and
settle-ride gates system callers on `token === SERVICE_ROLE_KEY` — the legacy
JWT falls through to `auth.getUser()` and 401s. Fetch it with
`supabase projects api-keys --reveal`.

```
curl -s -X POST "$SUPABASE_URL/functions/v1/settle-ride" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ride_id":"<ride>","action":"cancel","reason":"passenger_cancelled"}'
```

**PASSED 2026-08-13**: both calls returned `{"ok":true,"already":"cancelled"}`
at HTTP 200, row untouched.

→ `{ok:true, already:'cancelled'}`, no 500, PI still `canceled`, and
`cancelled_at`/`cancelled_reason` unchanged from the original cancel.
Service-role resolves `actor:'system'`, but the TERMINAL guard (line 242) runs
ahead of every actor branch, so this is the same path a passenger's second tap
would take.

The Stripe key/param collision is **not testable and no longer possible**:
`releaseHold` returns at the already-`canceled` check before issuing any Stripe
write, so a second call never reaches the API. The key is now
`settle-${ride.id}-${cancellationReason}` (2026-08-13) so differing reasons
can't collide at all; identical retries still dedupe.

### 7. Sweeps
Invoke manually (service-role — run as `!curl` so the key stays out of the
transcript):

```
curl -s -X POST "$SUPABASE_URL/functions/v1/expire-pending-rides" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
```
Returns `{expired, retried, missed, stranded, captured, stuck}`.

**Setup gotcha for 7a/7b.** Both fuses read a timestamp that a BEFORE UPDATE
trigger owns, and neither can be backdated by a later UPDATE:
`trg_guard_and_stamp_ride_lifecycle` sets `cancelled_at := now()` on the
transition into `cancelled` then freezes it, and `trg_ride_completed_at` does
the same for `completed_at`. Setting the column in the *same* statement as the
transition does not help either — the trigger's ELSIF assigns `now()` over
whatever you passed. So: either wait the 10 minutes, or disable the one trigger
for the statement. Run the three lines as a single batch so a failure can't
leave the trigger off.

Also expect side effects: these transitions fire `notify-passenger` and
`send-ride-receipt`, so the test passenger gets a real push/email.

- **7a Sweep A** — cancelled ride whose hold nobody released. `payment_status`
  must be `pending`/`failed`; a real settle-ride cancel writes `unpaid`, which
  the sweep deliberately ignores.
  ```sql
  alter table rides disable trigger trg_guard_and_stamp_ride_lifecycle;
  update rides set status = 'cancelled', payment_status = 'pending',
                   cancelled_at = now() - interval '15 minutes',
                   cancelled_from_status = 'assigned'
   where id = '<ride>';
  alter table rides enable trigger trg_guard_and_stamp_ride_lifecycle;
  ```
  Sweep → `stranded: 1`, PI `canceled`.

  **RUN 2026-08-13: `stranded: 28`.** Not manufactured — 28 real pre-migration
  cancelled card rides were sitting with a live PI and `payment_status`
  pending/failed. They were invisible to the original query: all have
  `cancelled_at IS NULL` (no backfill, by design) and PostgREST `lt` excludes
  NULLs, so the sweep skipped exactly the population it exists for. Fixed by
  treating NULL as sweepable; self-draining, since `release_hold` stamps
  `payment_status='unpaid'`. After the run: 0 candidates remain, all 31
  cancelled-with-PI rides read `unpaid`. Most were June rides whose holds had
  already expired at Stripe; `68119797` (08-08) and `21f1cbc0` (08-09) were
  inside the ~7-day window and are the two worth confirming as `canceled` in
  the Stripe dashboard.
- **7b Sweep B** — completed card ride the driver's phone never captured.
  ```sql
  alter table rides disable trigger trg_ride_completed_at;
  update rides set status = 'completed', payment_status = 'pending',
                   completed_at = now() - interval '15 minutes'
   where id = '<ride>';
  alter table rides enable trigger trg_ride_completed_at;
  ```
  Sweep → `captured: 1`, PI `succeeded` (a real sandbox charge), and
  `capture-payment` accepted the service-role caller.

  **PASSED 2026-08-13** on ride `78e483c5`. Note the cron is `* * * * *`, so it
  fired 14s after staging and did the capture — the manual invoke then correctly
  reported `captured: 0` with nothing left to do. `payment_status: succeeded`,
  `fare_final: 24.96` written back from the Stripe-authorized amount. If you
  stage and immediately invoke, expect the count to land on the cron's run, not
  yours.
- **7c Sweep C** — no trigger problem here: `assigned_at`/`arrived_at` are
  deliberately NOT frozen, and the transition into `in_progress` doesn't
  re-stamp them, so one statement does it.
  ```sql
  update rides set status = 'in_progress',
                   assigned_at = now() - interval '7 hours',
                   arrived_at  = now() - interval '7 hours'
   where id = '<ride>';
  ```
  Sweep → `stuck: 1`, `cancelled_reason: 'stuck'`, logged at warn.

  **PASSED 2026-08-13**, run on three synthetic rides (inserted, then deleted —
  no real rides touched) to cover the liveness rope as well:
  - no driver, 7h old → cancelled `stuck` ✓
  - driver heartbeating within 30 min, 7h old → **skipped**, still
    `in_progress` ✓ (the 12h rope for a plausibly-real long trip)
  - same live driver, 13h old → cancelled `stuck` ✓

  Gotcha if you rebuild these: the age anchor is the LATEST past stamp among
  arrived_at/assigned_at/scheduled_at/created_at, so `created_at` has to be
  backdated too or a fresh row is never sweepable.

  **But check the driver first.** The in_progress branch re-reads
  `drivers.last_seen_at` and skips any ride whose driver heartbeat is fresher
  than 30 min until double the fuse (12h). Expo Go runs the local heartbeat
  code, so a test driver with the app open IS live and this ride will be
  correctly skipped — which looks exactly like a failure. Either use a ride
  whose driver has the app closed, or backdate 13+ hours.

### 8. Card-decline ladder
**Card choice matters.** Stripe validates at attach time, so most decline cards
(`...9995` insufficient_funds, `...9987` lost_card) fail in `save-card` and
never reach the ladder — the app correctly shows the decline. Only
`4000000000000341` attaches successfully and fails when charged, which is the
shape the ladder needs. There is no good test card for a HARD decline; simulate
that branch by setting `payment_check_status='hard_failed'` on the row and
confirming attempts stop.

**Book 60+ minutes out.** With `CARD_RETRY_MINS = 10` and a per-ride release
threshold anywhere in 10–75 min, a short lead shows `att=1` then fallback —
indistinguishable from the broken behaviour below.

**BUG FOUND 2026-08-13 (fixed):** the ladder was dead code. The cash-fallback
block sat at the top of `releaseRide`, which runs for EVERY ride in the 75-min
window, not only at release — so the first soft decline flipped the ride to
cash instantly (observed: `generic_decline` at T-25m → `cash_fallback`, att
frozen at 1) and the `soft_failed` latch was overwritten in the same
invocation. A passenger whose card declines once loses the card ride up to an
hour early. Three fixes: fallback moved into `executeRelease` (the sole release
door); a guaranteed last-chance `ensurePaymentIntent` immediately before it
(keyed off release, NOT `MIN_LEAD_MINS` — a ride releasing at T-30 would never
reach a T-10 last try); and a `CARD_RETRY_MINS` throttle, since the 2-min cron
over a 75-min window would otherwise fire ~37 declined authorizations at one
card and look like card testing to Stripe Radar.

Attach `4000000000000341` as the passenger default, book a scheduled card ride
60+ min out, let `scheduled-release` reach it.
**PART A PASSED 2026-08-14** on ride `3d0bb484` (booked T-60):

| attempt | at | latch |
|---|---|---|
| att=1 | T-59 | soft_failed / generic_decline |
| att=2 | T-47 | soft_failed |
| att=3 | T-35 | soft_failed |
| att=4 | T-22 | soft_failed |
| att=5 | T-17 | last-chance at release, then cash_fallback |

Retries spaced ~12 min (CARD_RETRY_MINS=10 plus tick alignment). att=5 came
only 5 min after att=4 — that is the guaranteed last-chance attempt inside
`executeRelease` deliberately bypassing the throttle. Release happened at T-17,
NOT the T-10 floor, which is exactly the case the first version of the fix
would have missed. Ride then released normally as `pending` + `cash`.

→ soft decline: `payment_check_status: 'soft_failed'`, attempts increments,
  retried next tick.
→ at release with still no PI: `cash_fallback` — `payment_method` flips to
  `cash`, BOTH passenger and driver pushed, driver can complete without
  "No payment intent found".

## Not testable from the SQL editor

The guard's client-write rejection (a passenger clearing their own
`no_show_at`) can't be exercised in the SQL editor — no JWT means
`auth.role()` is NULL and the guard is skipped by design. It'd need a PostgREST
call carrying a real passenger token. Verified by reading only.

## Parked follow-ups

- **Passenger-initiated cash switch has no UI.** `settle-ride`'s `cash_fallback`
  permits `actor === 'passenger'`, but nothing in mgcj-app or mgcj-dashboard
  ever calls it — only `scheduled-release` does. Natural home is a
  "Pay with cash instead" action on the ScheduledRidesScreen card, most useful
  once `payment_check_status = 'soft_failed'`. One-way (guard_ride_payment_method
  blocks cash→card from the client), so it needs a confirm dialog, not a toggle.
  Deferred 2026-08-13 — decide whether it's worth building.
