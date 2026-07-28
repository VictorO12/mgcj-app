-- Carries the driver's live ETA (seconds) to the current active-ride target
-- (pickup while heading to pickup, dropoff once in_progress). The DRIVER's
-- active-ride screen already computes a traffic-aware route ETA and interpolates
-- it locally each GPS tick, so it broadcasts that value here alongside its
-- location. The passenger's useActiveRide reads it off the same Realtime channel
-- it already subscribes to — eliminating the passenger app's per-location-update
-- Google Directions call (the single largest Maps cost, ~200 calls/ride).
--
-- Nullable, no default: null means "no active ride ETA" and the passenger UI
-- shows "--". Cleared to null when the driver's active-ride screen unmounts.
--
-- No GRANT statements: `drivers` predates the post-2026-10-30 grant requirement,
-- and adding a column inherits the table's existing privileges.
alter table public.drivers
  add column if not exists active_ride_eta_seconds integer;

comment on column public.drivers.active_ride_eta_seconds is
  'Driver-broadcast ETA (seconds) to the current active-ride target; null when no active ride. Written by the driver app, read by the passenger app via Realtime.';
