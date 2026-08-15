-- Run these THREE checks in the Supabase SQL editor BEFORE applying
-- 20260743_soft_scheduled_claims.sql. Each one can change what ships.

-- ── 1. assignment_source constraint name (BLOCKS the migration) ──────────────
-- The migration drops `rides_assignment_source_check` by name. That is the
-- Postgres auto-name for an inline ADD COLUMN ... CHECK, but 20260706 was
-- applied by hand, so the live name is unverified. If it differs, the DROP
-- silently no-ops, the ADD creates a SECOND check, and the old one rejects
-- 'driver_claim' — every claimed ride then fails its release UPDATE, logs
-- "already released — skipping preferred offer", and the claimant silently
-- never receives the ride. Fix the name in the migration to match this output.
select conname, pg_get_constraintdef(oid)
from   pg_constraint
where  conrelid = 'public.rides'::regclass
and    conname like '%assignment_source%';

-- ── 2. the RLS policy this whole change is premised on ───────────────────────
-- Expected: qual = (driver_id = auth.uid()), i.e. NO `driver_id IS NULL` arm,
-- which is what makes the old client-side claim impossible. Inferred from
-- migration ordering (both files are dated 20260627), never confirmed live.
-- If the NULL arm IS still there, the old claim path worked in the field and
-- check 3 below matters a great deal more.
select policyname, qual, with_check
from   pg_policies
where  tablename = 'rides'
and    policyname = 'Drivers can update their rides';

-- ── 3. rides already claimed the old way ─────────────────────────────────────
-- These sit in the broken state: scheduled-release pool-releases them and
-- assign-ride overwrites driver_id, so the driver loses a ride they think is
-- theirs. Dispatch-assigned scheduled rides look identical, so DON'T bulk-fix —
-- eyeball the list first. Non-zero count needs a decision before rollout.
select id, driver_id, confirmed_by_driver, scheduled_at, preferred_driver_id
from   rides
where  status = 'scheduled'
and    driver_id is not null
and    scheduled_at > now()
order  by scheduled_at;
