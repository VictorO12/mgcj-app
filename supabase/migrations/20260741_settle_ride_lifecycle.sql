-- Step 1 of the hold-lifecycle fix: the columns settle-ride needs.
--
-- Three groups, all on `rides`:
--
--   1. payment_check_*  — the card-verification latch. Deliberately SEPARATE
--      from payment_status, which is already doing double duty as Stripe PI
--      state (stripe-webhook) and capture state (capture-payment). Overloading
--      it is what produced the dead end at scheduled-release/index.ts:126,
--      where payment_status='failed' permanently skipped PI creation and
--      nothing anywhere ever cleared it — so the "please update your card"
--      push was a lie: updating the card could never trigger a retry.
--
--   2. Lifecycle stamps (assigned_at / arrived_at / cancelled_at /
--      cancelled_from_status) — needed by the staleness sweeps and the
--      no-show geo+time gate. Nothing equivalent existed.
--
--   3. no_show_at — records a driver-filed passenger no-show. No fee is
--      charged today; this is recorded now so pricing one later is a pricing
--      decision, not another migration. It is also the input to a future
--      booking-time gate on passengers with a no-show/unpaid history.
--
-- FREEZE SEMANTICS — note the deliberate split:
--   • cancelled_at / cancelled_from_status are frozen once set, like
--     completed_at (20260718). 'cancelled' is terminal, so re-entry is not a
--     case that exists.
--   • assigned_at / arrived_at are NOT frozen: they re-stamp on every
--     transition INTO their status, because a reassigned ride should restart
--     its staleness fuse. They are still immune to unrelated writes (an admin
--     edit cannot bump them), which is the property that matters — the
--     updated_at lesson from 20260718. They are fuse inputs ONLY. Never use
--     them for revenue/reporting buckets; use completed_at for that.
--
-- NO BACKFILL, deliberately. An invented assigned_at/arrived_at on a ride
-- already in flight is a guess, and these drive automatic cancellation — a
-- wrong guess cancels a live ride. Rides in flight at deploy time therefore
-- carry NULL stamps, and expire-pending-rides' stuck sweep falls back through
-- scheduled_at to created_at for them. That fallback must never land on a
-- FUTURE timestamp (a scheduled ride booked weeks out) or the ride's computed
-- age goes negative and it becomes permanently unsweepable; the sweep filters
-- its candidate timestamps to those already past for exactly this reason.

alter table rides
  add column if not exists payment_check_status  text        null,
  add column if not exists payment_check_attempts integer     not null default 0,
  add column if not exists payment_check_last_at  timestamptz null,
  add column if not exists payment_check_last_code text       null,
  add column if not exists assigned_at            timestamptz null,
  add column if not exists arrived_at             timestamptz null,
  add column if not exists cancelled_at           timestamptz null,
  add column if not exists cancelled_from_status  text        null,
  add column if not exists no_show_at             timestamptz null;

-- NULL = never attempted, which is what every existing row must mean so the
-- ladder treats pre-migration rides as fresh rather than as failures.
alter table rides
  drop constraint if exists rides_payment_check_status_check;
alter table rides
  add constraint rides_payment_check_status_check
  check (payment_check_status is null or payment_check_status in (
    'pending',        -- attempt in flight
    'verified',       -- hold placed successfully
    'soft_failed',    -- retryable decline (insufficient_funds, processing_error)
    'hard_failed',    -- terminal decline (lost/stolen/expired card) — do not retry
    'cash_fallback'   -- card gave up; this ride is cash, and the passenger was told
  ));

-- ── Guard + stamps, deliberately ONE trigger ────────────────────────────
-- These were originally two triggers (a guard rejecting client writes to the
-- server-owned columns, and a stamper setting them) whose correctness rested
-- on BEFORE-UPDATE triggers firing in alphabetical name order: the guard had
-- to inspect the client's row BEFORE the stamper legitimately wrote
-- cancelled_at/assigned_at/arrived_at into it. If that order ever inverted --
-- a rename, a re-create, a future Postgres change -- the guard would reject
-- the stamper's own writes and a DRIVER COULD NO LONGER ADVANCE A RIDE. That
-- is a total dispatch outage, not a degraded path, so the ordering dependency
-- is removed rather than documented: one function, guard first, then stamp.
--
-- Guard rationale (same as guard_ride_fare_fields, 20260713): RLS gates rows,
-- not columns, so a passenger can UPDATE their own ride row. Without this a
-- passenger could clear their own no_show_at to dodge the future booking
-- gate, or set payment_check_status='verified' to skip card verification.
--
-- Unlike the fare guard, dispatch admins are NOT allowed through: these are
-- machine state written by settle-ride and the verification ladder, not
-- fields a human edits. Direct DB access (no JWT -> auth.role() IS NULL) and
-- service_role stay allowed so manual fixes still work.
create or replace function guard_and_stamp_ride_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ── Guard: reject client writes to server-owned columns ──────────────
  -- Evaluated against the row as the client submitted it, before any stamp
  -- below touches it.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if new.payment_check_status    is distinct from old.payment_check_status
       or new.payment_check_attempts  is distinct from old.payment_check_attempts
       or new.payment_check_last_at   is distinct from old.payment_check_last_at
       or new.payment_check_last_code is distinct from old.payment_check_last_code
       or new.no_show_at              is distinct from old.no_show_at
       or new.cancelled_at            is distinct from old.cancelled_at
       or new.cancelled_from_status   is distinct from old.cancelled_from_status
       or new.assigned_at             is distinct from old.assigned_at
       or new.arrived_at              is distinct from old.arrived_at then
      raise exception 'Ride lifecycle/payment-check fields are server-owned';
    end if;
  end if;

  -- ── Stamps ───────────────────────────────────────────────────────────
  -- Terminal + frozen: once cancelled, these never move again.
  if old.cancelled_at is not null then
    new.cancelled_at          := old.cancelled_at;
    new.cancelled_from_status := old.cancelled_from_status;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at          := now();
    new.cancelled_from_status := old.status;
  end if;

  -- Fuse inputs: re-stamp on each entry into the status (a reassignment
  -- restarts the clock), but never bumped by an unrelated write to the row.
  if new.status = 'assigned' and old.status is distinct from 'assigned' then
    new.assigned_at := now();
  end if;

  if new.status = 'driver_arriving' and old.status is distinct from 'driver_arriving' then
    new.arrived_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ride_lifecycle_stamps on rides;
drop trigger if exists trg_guard_ride_machine_fields on rides;
create trigger trg_guard_and_stamp_ride_lifecycle
  before update on rides
  for each row
  execute function guard_and_stamp_ride_lifecycle();

-- ── Indexes for the expire-pending-rides sweeps ─────────────────────────
-- Each sweep scans a narrow slice of a table that is mostly terminal rows,
-- so partial indexes keep them cheap as ride volume grows.

-- Sweep A: cancelled rides whose hold was never released.
create index if not exists idx_rides_stranded_hold
  on rides (cancelled_at)
  where status = 'cancelled'
    and stripe_payment_intent_id is not null;

-- Sweep B: completed card rides never captured (driver's phone died).
create index if not exists idx_rides_uncaptured
  on rides (completed_at)
  where status = 'completed'
    and payment_method = 'card'
    and stripe_payment_intent_id is not null;

-- Sweep C: rides stuck mid-flight that nobody closed out.
create index if not exists idx_rides_stuck_active
  on rides (status, assigned_at)
  where status in ('assigned', 'driver_arriving', 'in_progress');

-- Columns on an existing, already-granted table — no new GRANTs required
-- (the post-2026-10-30 rule applies to CREATE TABLE, not ALTER TABLE).
