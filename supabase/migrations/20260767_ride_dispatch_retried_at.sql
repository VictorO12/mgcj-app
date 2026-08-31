-- One retry means ONE retry.
--
-- `expire-pending-rides` runs every minute and re-opens a ride's dispatch
-- history for anything pending between 2 and 5 minutes — a three-minute window,
-- so it actually fired THREE times per ride, wiping `declined_by` (and, as of
-- the same day, `timed_out_by`) on every pass.
--
-- That silently defeats every "we already asked this driver" rule downstream.
-- Observed 2026-08-30 on ride 27ee5a5c: assign-ride's new two-strike rule
-- (a second timeout from the same driver counts as a decline) could never
-- trigger, because the counter was erased between every timeout. The ride
-- re-offered itself to the same unresponsive phone once a minute until it was
-- cancelled — the exact loop the two-strike rule had just been written to stop,
-- reintroduced one function over.
--
-- A timestamp rather than a boolean: it says WHEN, which is what you want when
-- reading a stuck ride's history afterwards, and it is null for every ride that
-- has never needed a retry.
alter table public.rides
  add column if not exists dispatch_retried_at timestamptz;

comment on column public.rides.dispatch_retried_at is
  'Set by expire-pending-rides when it re-opens a ride to all drivers (clearing declined_by/timed_out_by). Non-null means that one-time reopening has been used; the retry skips such rides so a per-minute cron cannot keep resetting dispatch history.';

-- No GRANT block needed: this is an existing table, and column privileges
-- follow the table-level grants already in place on public.rides. (Contrast a
-- NEW table, which needs explicit grants post-2026-10-30.)
