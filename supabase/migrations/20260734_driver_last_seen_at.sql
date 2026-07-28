-- Driver liveness / phantom-online reaper.
--
-- Problem: `drivers.is_active` is a manual toggle with no liveness check. A
-- driver who closes the app, backgrounds it, or forgets to go offline stays
-- is_active=true forever — a "phantom" that gets auto-assigned rides it never
-- sees, freezes its last known location, and inflates coverage_status.
--
-- Fix: the mobile app already heartbeats every ~10s while online. Record that
-- heartbeat in a dedicated column (NOT updated_at — an unrelated admin edit to
-- the row would bump updated_at and make a phantom look live, the same
-- anti-pattern already documented for rides). Then:
--   Layer 1 (dispatch filter, in edge functions): exclude drivers whose
--     last_seen_at is older than 60s from all availability/coverage reads.
--   Layer 2 (this reaper, run from scheduled-coverage-monitor every 10 min):
--     flip genuinely-abandoned drivers (stale > 5 min) offline so the roster
--     and map pin tell the truth and they see "offline" on reopen.

alter table public.drivers
  add column if not exists last_seen_at timestamptz;

-- Deliberately NO backfill. Leaving currently-online drivers at NULL is what
-- keeps them dispatchable across the rollout: the edge-function filter and the
-- reaper both treat NULL as live (pre-heartbeat app builds don't write this
-- column, and store/EAS rollout isn't atomic). A backfill would stamp an
-- old-app driver once, let it go stale in 60s, and then wrongly filter+reap the
-- exact population NULL-tolerance protects. NULLs disappear on their own as
-- clients update to the heartbeat build.

-- Speeds up the reaper's global scan and the per-company liveness filter.
create index if not exists idx_drivers_active_last_seen
  on public.drivers (last_seen_at)
  where is_active;

-- Layer 2 reaper. SECURITY DEFINER so it can be called via service-role RPC
-- from the scheduled-coverage-monitor edge function.
--
-- Guards:
--   * only touches is_active=true rows (nothing to reap otherwise)
--   * NULL last_seen_at is skipped (pre-heartbeat app builds — see Layer-1 note)
--   * NEVER reaps a driver on an active ride: the heartbeat runs during
--     assigned/driver_arriving/in_progress specifically to feed passenger ETA
--     tracking, and a brief signal drop there (tunnel) must not null their
--     location or flip them offline mid-fare.
create or replace function public.reap_stale_drivers(stale_minutes int default 5)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reaped integer;
begin
  with victims as (
    update public.drivers d
       set is_active = false,
           current_lat = null,
           current_lng = null
     where d.is_active = true
       and d.last_seen_at is not null
       and d.last_seen_at < now() - make_interval(mins => stale_minutes)
       and not exists (
         select 1 from public.rides r
          where r.driver_id = d.id
            and r.status in ('assigned', 'driver_arriving', 'in_progress')
       )
    returning 1
  )
  select count(*) into reaped from victims;
  return reaped;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, AND Supabase's default privileges
-- grant EXECUTE directly to anon/authenticated — either of which would let a client
-- call this SECURITY DEFINER writer via PostgREST. Revoke from PUBLIC and both roles
-- by name, then lock EXECUTE to service_role (the edge-function/cron caller) only.
revoke execute on function public.reap_stale_drivers(int) from public, anon, authenticated;
grant execute on function public.reap_stale_drivers(int) to service_role;
