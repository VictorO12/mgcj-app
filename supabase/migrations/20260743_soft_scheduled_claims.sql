-- Soft driver claims on scheduled rides.
--
-- A driver browsing the "Available" board can claim a scheduled ride in advance
-- so they can plan their day. The claim is deliberately NON-BINDING: it writes
-- preferred_driver_id (soft, never exclusive) rather than driver_id, so the ride
-- stays in the normal scheduled-release pipeline and gets re-confirmed at release
-- time. If the claimant isn't viable then, the ride falls through to the pool
-- exactly as an unclaimed ride would.
--
-- Why the old path had to change: claimOpenRide/claimScheduledRide bound
-- driver_id directly. That write SUCCEEDED (verified against the live policy on
-- 2026-08-15: USING allows driver_id IS NULL, WITH CHECK requires the new row's
-- driver_id to be the caller) — and was then silently undone, because
-- scheduled-release pool-releases any ride with no preferred_driver_id and
-- assign-ride overwrites driver_id with the closest driver. The driver planned
-- their day around a ride that quietly went to someone else.
--
-- Note the live policy is why a soft claim still cannot be a client write:
-- WITH CHECK (driver_id = auth.uid()) permits a driver to claim a ride only by
-- HARD-binding themselves to it, which is precisely the behaviour being removed.
-- Leaving driver_id NULL fails the check, so the claim runs service-side.
--
-- No GRANT statements: `rides` predates the post-2026-10-30 grant requirement and
-- new columns inherit the table's existing privileges.

alter table public.rides
  -- Set when a DRIVER self-claims; null when preferred_driver_id was set by
  -- dispatch. The pipeline treats the two differently (a self-claim is timed off
  -- the pool and may be held for a busy claimant; a dispatch preference keeps its
  -- existing behaviour), so the distinction needs to be persisted, not inferred.
  add column if not exists claimed_at                   timestamptz null,

  -- When the pre-release check-in push was sent, for idempotency. The check-in is
  -- ASYMMETRIC by design: only an explicit "can't make it" acts on the ride. No
  -- response is not a demotion — the driver may be mid-ride with the phone in a
  -- cradle, and the release-time viability check already handles silence.
  add column if not exists claim_checkin_at             timestamptz null,

  -- Last projected free-time for a claimant being held mid-ride. Compared tick to
  -- tick so a driver whose ETA is slipping (rather than converging) releases the
  -- ride early instead of burning the whole runway.
  add column if not exists claim_hold_projected_free_at timestamptz null;

comment on column public.rides.claimed_at is
  'When a driver soft-claimed this scheduled ride from the Available board. Non-binding: sets preferred_driver_id (soft), not driver_id. Null for dispatch-set preferences.';
comment on column public.rides.claim_checkin_at is
  'When the pre-release "still good?" push was sent to the claimant. Idempotency only — no response is not treated as a decline.';
comment on column public.rides.claim_hold_projected_free_at is
  'Last projected free-at for a mid-ride claimant being held past release threshold; used for slip detection.';

-- Distinguish a ride the claimant won off the board from one dispatch preferred,
-- so "how much work is the Available board actually moving?" is answerable.
alter table public.rides
  drop constraint if exists rides_assignment_source_check;
alter table public.rides
  add constraint rides_assignment_source_check
  check (assignment_source in ('preferred','auto_offer','dispatch_manual','driver_claim'));

-- ── Freeze the claim fields against client writes ───────────────────────────
-- Same lesson as guard_ride_fare_fields / guard_ride_payment_method: RLS gates
-- ROWS, not COLUMNS, and the live "rides: passenger can update own" policy is
-- USING (auth.uid() = passenger_id) with no column restriction. Without this a
-- passenger could set preferred_driver_id + claimed_at on their OWN ride and
-- hand-pick their driver — scheduled-release would dutifully offer it to whoever
-- they named. Drivers are blocked for the mirror-image reason: a claim must go
-- through claim-scheduled-ride, which enforces company, vehicle class, and the
-- single-winner race guard.
--
-- Allowed: service-role Edge Functions, direct DB access (auth.role() NULL), and
-- dispatch staff, who set preferred_driver_id from the dashboard by design.
CREATE OR REPLACE FUNCTION guard_ride_claim_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.preferred_driver_id          IS NOT DISTINCT FROM OLD.preferred_driver_id
 AND NEW.preferred_driver_exclusive   IS NOT DISTINCT FROM OLD.preferred_driver_exclusive
 AND NEW.claimed_at                   IS NOT DISTINCT FROM OLD.claimed_at
 AND NEW.claim_checkin_at             IS NOT DISTINCT FROM OLD.claim_checkin_at
 AND NEW.claim_hold_projected_free_at IS NOT DISTINCT FROM OLD.claim_hold_projected_free_at
  THEN
    RETURN NEW;
  END IF;

  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF get_my_role() IN ('admin', 'dispatcher') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'claim fields are managed by dispatch — use claim-scheduled-ride';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ride_claim_fields ON rides;
CREATE TRIGGER trg_guard_ride_claim_fields
  BEFORE UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION guard_ride_claim_fields();

-- Claim check-ins sweep every open claimed ride each 2-minute tick.
create index if not exists idx_rides_claimed_open
  on public.rides (scheduled_at)
  where claimed_at is not null and status = 'scheduled';
