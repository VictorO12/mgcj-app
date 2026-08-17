# E7 — stuck `in_progress` ride: plan

Written 2026-08-16. Design agreed with Victor; not yet built.

## Problem

A driver who mis-marks pickup puts the ride in `in_progress` with the passenger
never aboard. The passenger then has:

- no cancel (`RideTrackingSheet.tsx:321` hides it at `in_progress`)
- no rebooking (`PassengerHomeScreen.tsx:1092/1138/1235` suppress the whole
  booking UI while `hasActiveRide`)
- no escalation that reaches dispatch in time

and dispatch has no `in_progress` controls in the dashboard either, so nobody
can resolve it from either end.

`ReportDriverModal` is visible at `in_progress` but does not cover this: all
nine reason codes accuse the driver of misconduct, it is single-shot (unique
constraint per ride, row goes `disabled` once filed), and it lands in a list
page rather than alerting anyone.

## Key finding: the server already encodes the right policy

The passenger-cancel block is deliberate and stays. Fraud rationale: a
passenger could cancel near the end of a trip to dodge the fare, and a driver
could propose "cancel the $20 and give me $15 cash". Both are real.

The asymmetry is already written down server-side:

| | source | statuses |
|---|---|---|
| `PASSENGER_CANCELLABLE` | `settle-ride/index.ts:187` | scheduled, pending, offered, assigned, driver_arriving |
| `ADMIN_CANCELLABLE` | `settle-ride/index.ts:188` | ...same + **in_progress** |
| `RELEASABLE_STATUSES` (driver) | `settle-ride/index.ts:48` | assigned, offered, scheduled — **no in_progress** |
| `DROPOFF_EDITABLE` | `edit-ride/index.ts:86` | ...through **in_progress**, both actors |
| `PICKUP_EDITABLE_ADMIN` | `edit-ride/index.ts:93` | stops before in_progress |
| `RESCHEDULABLE_ADMIN` | `edit-ride/index.ts:96` | stops before in_progress |

So: passenger can't cancel mid-ride, driver can't release mid-ride, dispatch
can cancel and can move the destination but not the pickup or the time. That is
exactly the intended rule. **The dispatch gap is UI-only.**

Dashboard evidence it is an oversight, not policy:
- live panel has action blocks for `assigned` (`DashboardPage.tsx:3871`) and
  `driver_arriving` (`:3979`), none for `in_progress`
- modal Edit gated by `NON_EDITABLE_STATUSES` (`:35`, used `:5344`)
- yet `:5043` already carries an `in_progress`-specific fare hint explaining
  mid-ride re-pricing — copy that can never render today

## Why dispatch-cancel is safe where passenger-cancel is not

Not capability — the collusion just re-routes through a phone call to dispatch.
**Attribution.** `cancelRide` already calls `logDispatchEvent`, so every
mid-ride cancel is stamped with a named dispatcher in `dispatch_events`. Keep
that call on any new path; it is the load-bearing mitigation.

---

## Phase 1 — dispatch regains `in_progress` (mgcj-dashboard only)

No backend change required. Add an `in_progress` action block to the live panel:

- **Cancel ride** — reuses `cancelRide` → `settle-ride` `{action:'cancel'}`,
  which already accepts `in_progress` for an admin actor.
- **Restricted edit** — dropoff + fare only. Do NOT simply drop `in_progress`
  from `NON_EDITABLE_STATUSES`: that set is monolithic and would expose pickup
  and `scheduled_at` fields the server rejects (`PICKUP_EDITABLE_ADMIN`,
  `RESCHEDULABLE_ADMIN` both stop before `in_progress`). Needs a separate
  restricted mode in the editor, which then makes the `:5043` hint reachable.

### Checked: the driver is told, and the screen tears down

`settle-ride`'s admin-cancel branch pushes **both** parties (`index.ts:467-473`)
— passenger *and* driver — and `sendPush` no-ops on a null `driver_id`
(`:156`). On top of that, `DriverApp.tsx:358`'s realtime `rides` subscription
clears `activeRide`/`assignedRide` on `cancelled`, so the nav screen ends
itself and no stale `capture-payment` can fire.

Phase 1 therefore needs **no backend change at all** — not even the optional
push this note previously recommended.

### Accepted debt (Victor, 2026-08-16): driver is unpaid on a mid-ride cancel

`settle-ride`'s cancel branch runs `releaseHold` → hold released,
`payment_status: 'unpaid'`. The driver gets nothing for distance already
driven. There is no "capture what was driven" action — `no_show` is gated to
`driver_arriving`.

Correct for the phantom-ride case (no real distance driven). Wrong for a
genuine mid-ride abort (illness, breakdown). **Decision: ship as-is now,
implement later.** Options when revisited: a `settle_driven` action doing a
Stripe partial capture priced off `edit-ride`'s driven-leg logic, or stamping
the driven distance/fare at cancel time for an out-of-band make-good.

## Phase 2 — passenger escalation (BUILT 2026-08-16, not yet applied/tested)

A flag, **never** a cancel.

- Migration: `rides.passenger_flagged_at timestamptz`,
  `rides.passenger_flag_reason text`. Columns on `rides`, not a new table — it
  rides the dashboard's existing `rides` realtime subscription and skips new
  RLS plus the post-Oct-2026 grant convention.
- Verified: `guard_ride_route_fields` / `guard_ride_fare_fields` are
  **denylists** naming specific columns, so a new column stays
  passenger-writable without touching them. Re-verify live before relying on
  it (`pg_trigger` / `pg_proc`), per the migration-files-are-not-applied-state
  rule.
- New sheet in `RideTrackingSheet`, placed **above** "Change destination" so a
  confused passenger reaches it first.
- Reason codes must include **"I'm not in this car / the trip started without
  me"** as a first-class option. That is the whole point; the existing nine
  `driver_reports` codes are misconduct accusations and do not cover it.
- Plus an **optional** "Call dispatch" action — the passenger chooses whether
  to call. Requires a new `companies.phone` column: confirmed absent
  (`SettingsPage.tsx` collects `phone` on *staff profiles*, not on the
  company). Needs per-company data entry at onboarding.

### Two decisions to record

**The passenger can clear their own flag.** A denylist guard plus passenger
UPDATE on their own ride makes `passenger_flagged_at` writable *and* nullable
from the client — a dispatcher could watch a flag vanish mid-triage. Either
accept it (a passenger un-flagging is usually a genuine "never mind") or add
the two columns to `guard_ride_route_fields`'s denylist, which forces the write
through an Edge Function. **Leaning: accept, but have dispatch keep the
dismissed flag in the Phase 3 archive so it cannot be erased from the record.**

**Why a direct client write to `rides` is acceptable here**, when this codebase
has systematically moved passenger writes off `rides` into Edge Functions
(`settle-ride` absorbed four bare status writers, `edit-ride` absorbed the
client-side time edit, `dispatch-assign-ride` moved out of the dashboard): the
flag resets nothing, touches no money, and triggers no pipeline — and both
existing report modals (`ReportDriverModal`, `ReportProblemModal`) already
insert client-side. Recorded so a future reader doesn't read it as an oversight.

**Not touching:** "Change destination" at `in_progress`. It is a footgun for a
phantom ride (`edit-ride` prices mid-ride as driven + remaining off the
driver's live position, so redirecting a ride you were never on bills you for
it) — but C6 just shipped and was live-tested. Fix is placement, not a gate.

### What Phase 2 actually shipped

- `supabase/migrations/20260752_passenger_ride_flag.sql` — flag columns on
  `rides`, `companies.phone`, and two SECURITY DEFINER RPCs.
  **NOT YET APPLIED** — run it in the SQL editor per the usual convention.
- `mgcj-app/src/components/RideProblemModal.tsx` — the escalation sheet.
- `RideTrackingSheet.tsx` — "Something's wrong with this ride" row, amber,
  placed **above** "Change destination" on purpose.
- `mgcj-dashboard` — `companies.phone` field in Settings, red flag badge +
  "Mark resolved" on the active ride card, and a toast on the transition into
  flagged.

**Why RPCs rather than a direct client write** (the plan originally said direct):
passengers have **no** `profiles.company_id` — only drivers get one, from their
invite — so `companies_select` (`id = get_my_company_id()`) returns them
nothing and the dispatch phone is unreadable from the client. Widening that
policy would re-open the exact cross-tenant leak `20260745` closed. A definer
function returning one column for one ride you own is strictly narrower. Having
paid for one RPC, `flag_ride` follows: it validates the reason, stamps server
time, and — the real win — **bypasses RLS**, so it does not depend on the
passenger UPDATE policy on `rides`. (That policy is asserted live by CLAUDE.md
but is not created by any migration in the repo — applied by hand, most likely.
Not a claim that it is missing; a definer write simply makes the question moot.)

**Why the flag columns are NOT in a guard denylist**: `guard_ride_route_fields`
is SECURITY DEFINER but reads `auth.role()`, which still returns
`authenticated` inside `flag_ride` — denylisting them would block the very
write path this adds.

**Resolved, not cleared**: dispatch stamps `passenger_flag_resolved_at`. The
flag itself is never erased, so an escalation cannot vanish mid-triage. This
supersedes the earlier open question about the passenger clearing their own
flag — the RPC offers no clear path at all. Re-flagging is allowed and
overwrites (deliberately **not** single-shot, unlike `driver_reports`).

### Verified live 2026-08-16

Migration applied; checks in `.claude/notes/e7-flag-postapply-checks.sql`.

- Grants: `flag_ride(uuid,text[],text)` and `get_ride_dispatch_phone(uuid)` both
  `authenticated=true`, `anon=false`, `security_definer=true`. Exactly two rows,
  so the superseded `flag_ride(uuid,text,text)` overload is gone.
- Reachability: calling `flag_ride` as `SET ROLE authenticated` returns
  `ERROR: Ride not found` — the function's OWN rejection, raised from inside the
  body, which is the pass. `permission denied for function` would be the fail.
- Columns: exactly the five final ones; singular `passenger_flag_reason` gone.
- Dispatch phones set for both companies.

### Still to do for Phase 2
End-to-end test on a real device, then commit. Scenarios:

1. **The case this exists for.** Driver marks pickup without the passenger →
   passenger opens the sheet, ticks "I'm not in the car", sends. Dashboard: red
   badge on the active card + toast. Dispatch cancels mid-ride (Phase 1) →
   passenger and driver both get a push, driver's nav screen ends.
2. **Accumulation + pre-tick.** Flag "the driver never arrived", close the
   sheet, reopen: row reads "Dispatch has been told", that reason is ticked
   green and locked. Add "I feel unsafe" → dashboard heading becomes
   "Passenger flagged 2 issues" with both listed, most urgent first.
3. **Note-only follow-up.** Reopen with every relevant reason already locked,
   type only a note, send. Should succeed and append, not replace.
4. **Resolve.** "Mark resolved" on the dashboard → passenger's row flips from
   green back to amber "Something's wrong with this ride". Re-flagging then
   starts a clean episode (previous reasons NOT pre-ticked).
5. **Call dispatch.** Present both before sending and on the success screen;
   dials the number set in Settings.

### Follow-ups applied 2026-08-16 (Victor's review)

**Passenger now has durable confirmation.** The modal's success screen vanished
with the modal, so a passenger who closed it had no evidence their report
landed. `useActiveRide` now carries `passenger_flagged_at` /
`passenger_flag_resolved_at` (its `select('*')` already fetched them; the
assembly is explicit, so both had to be added by name), and the tracking-sheet
row flips to a green "Dispatch has been told · tap to add more or call them"
while a flag is outstanding. It clears itself when dispatch resolves — which
also means **a resolve is no longer completely silent** to the passenger, the
gap noted here previously. There is still no push on resolve; the change is
only visible if they have the app open.

**Multiple flags on ONE ride** — the real gap, and the first pass got it wrong.
`flag_ride` overwrote a single `passenger_flag_reason`, so "the driver never
came" followed later by "I feel unsafe" lost the first and dispatch saw only the
newest. Still deliberately NOT limited to one the way `driver_reports` is — that
lock is part of why that modal fails this case.

Reasons now **accumulate** in `rides.passenger_flag_reasons text[]`, deduped,
with notes appended. Chosen over a `ride_flags` table: a table buys per-flag
timestamps and history but costs new RLS, the post-Oct-2026 grants, and a second
realtime subscription, while the badge currently rides the existing `rides`
merge for free. Revisit if Phase 3's triage panel wants real history.

**Episode semantics** are load-bearing: an unresolved flag accumulates, and once
dispatch resolves, the next flag starts clean. Without the reset, reasons from a
handled problem would haunt a later unrelated one for the rest of the ride.
`passenger_flagged_at` holds the episode's open time (how long outstanding);
`passenger_flag_updated_at` moves on every flag (what dispatch sorts on).

**Pre-ticking** falls out of that: the modal is multi-select and shows already-
sent reasons ticked, green and locked ("Already sent to dispatch"), so nobody
re-reports the same thing. A note-only follow-up is still allowed — it is the
only way to add detail to a reason that is now locked. Copy shifts to "Add to
your report" / "Send update" when an escalation is already open.

Multiple flagged *rides* were never the problem — each card has its own badge.
The toast now names the most urgent reason with a `(+N more)` suffix, and
switches to a count when several rides are outstanding.

**Badge spacing** — the glyph and label were one text node; now a flex row with
a real gap.

## Phase 3 — dispatch alerts panel (mgcj-dashboard)

Flags surface as a **dashboard indicator, never a push** (locked-in rule:
dispatch never gets push notifications).

- A panel on the dashboard home, mirroring the existing active-rides panel but
  on the right. Dismissible/closable.
- Dismissed/archived flags go into a menu — likely folded into the existing
  Reports page (`ReportsPage.tsx`, currently "Driver Reports" only; the sidebar
  already has an open-report count at `DashboardPage.tsx:714/746`).
- Exact placement and layout deliberately left open — Victor: "we'll work this
  out later".

## Found while planning — separate bug, not part of E7

Both Help & Support screens ship **placeholder contact details**:

- `src/screens/passenger/HelpSupportScreen.tsx:73,77` — `tel:+19025550100`
  (a 555 fake number) and `mailto:support@mgcj.com`
- `src/screens/shared/HelpSupportScreen.tsx:62,66` — `tel:+19020000000`
  and `mailto:dispatch@mgcj.ca`

Three problems: the numbers are fake, the domains are wrong (vendor support is
`support@vellon.ca`, never an `mgcj.*` address), and on a multi-tenant platform
a *dispatch* number must come from the passenger's own company rather than be
hardcoded at all. The `companies.phone` column Phase 2 adds is the fix for the
third — worth doing these together.

## Build order

1. Phase 1 (self-contained, unblocks resolution from the dispatch end)
2. Phase 2 migration + `companies.phone`
3. Phase 2 app UI
4. Phase 3 panel

Phase 1 alone makes the trap resolvable by a dispatcher who notices. Phase 2+3
are what make anyone notice.
