# Can one passenger have two active rides at once?

Found 2026-08-17 while answering a multi-device question. **Own finding — blocks nothing,
and nothing blocks it.** Not part of the push-receipt or G3 work.

---

## The short answer

Single device: **no, structurally impossible.** Two devices: **yes, in a narrow race.**

---

## Why one device is already safe

`PassengerHomeScreen.tsx:1327` gates the entire booking block on `!hasActiveRide`, where
`hasActiveRide = !!ride` from `useActiveRide` (line 1083). Once a ride is active the booking
UI is not rendered at all — the confirm button is unreachable, so there is nothing to
double-tap.

This is worth stating explicitly because it is **enforced by UI structure, not by a check**.
Grepping for a guard finds nothing and gives the false impression that none exists. (I made
exactly that error before reading the render tree.)

## Where the hole is

Two devices signed into the same passenger account — possible because **`device_token` is
drivers-only**, so passengers have no single-device lock (`AuthContext.tsx:136` writes it to
`.from("drivers")`).

Both devices independently run `useActiveRide`. If **both have no active ride and both
confirm within the same few seconds**, both inserts succeed and the passenger now has two
rides in flight. After that, both phones settle: `useActiveRide` fetches with
`.limit(5)` and `.find(isRideNow)`, ordered `created_at desc`, so **both show the same one
ride and the other becomes invisible to the passenger** — they cannot even cancel it.

Dispatch, meanwhile, sees two live rides and assigns two drivers. One arrives to nobody.

**The realistic trigger is not two phones — it is phone + dispatch.** These are phone-first
customers: a passenger calls dispatch *and* opens the app. Dispatch books on their behalf
while they book in-app. Same outcome, and far more likely than a passenger owning two
handsets.

## Severity

Narrow window (seconds), but the cost is real: a dead trip for a driver, an unexplained
no-show, and an orphan ride the passenger has no way to cancel. Low frequency, poor
failure mode.

## What NOT to do

**Do not add a partial unique index** on `rides (passenger_id)` over the active statuses.
It looks like the clean fix and it would break the pipeline:

- `ACTIVE_STATUSES` is `pending, offered, assigned, driver_arriving, in_progress`
  (`useActiveRide.ts:37`) — `scheduled` is correctly not in it.
- But a passenger can legitimately hold a **scheduled ride for 6pm and take a spontaneous
  ride at 5:40**. `scheduled-release` then flips the scheduled ride `scheduled → pending`
  while the immediate one is still `in_progress`, and the index rejects the cron's UPDATE
  with a 23505.
- That failure lands in the pipeline whose errors are **already documented as invisible**:
  `cron.job_run_details` reports SUCCESS because `net.http_post` only enqueues, and the real
  status is in `net._http_response`, which nothing reads.

So a blanket invariant trades a rare double-book for a silent release failure. Strictly
worse. Same objection applies to any constraint that fires on UPDATE: `assign-ride`,
`dispatch-assign-ride`, `expire-pending-rides` and `edit-ride` all move rides within that
status set.

## What to do instead

**Enforce on INSERT only.** A `BEFORE INSERT` trigger on `rides` that rejects a new
`pending`/`offered` ride when the passenger already has one in the active set. Because it
never fires on UPDATE, every status transition above is untouched — that distinction is the
whole point of the approach.

Two details to settle when building it:
- **Dispatch override.** A dispatcher booking for a passenger who already has a live ride may
  be legitimate. Follow the existing pattern: allow admins/service-role through, the way
  `guard_ride_fare_fields` does — or make it a confirmable warning like the commitment guard,
  rather than a hard refusal.
- **`passenger_id` is nullable** (`delete-account` nulls it to detach records), so the check
  must skip NULL rather than treat all detached rides as one passenger.
