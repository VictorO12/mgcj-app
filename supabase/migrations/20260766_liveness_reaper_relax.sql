-- Driver liveness, part 2: stop punishing a locked phone.
--
-- Background (measured 2026-08-30). The mobile heartbeat is a plain JS
-- setInterval; there are no background modes, no TaskManager and no keep-awake
-- anywhere in the app, so it only runs while the app is FOREGROUNDED. That
-- makes `last_seen_at` a measure of "the app is on screen", not "this driver
-- can be given a ride" — while ride offers arrive as PUSH NOTIFICATIONS, which
-- reach a locked phone, a backgrounded app and even a killed one perfectly
-- well. A driver waiting at the stand with their phone in their pocket was
-- indistinguishable from one who had gone home.
--
-- Two consequences were live: the 60s dispatch filter excluded them from
-- offers, and this reaper flipped `is_active` to false after 5 MINUTES and
-- nulled their location, so they had to notice and toggle themselves back on.
--
-- What changes here:
--   1. 5 minutes -> 4 hours. The reaper no longer carries the dashboard: it
--      now derives online/away/offline itself from is_active + last_seen_at
--      (mgcj-dashboard/src/lib/presence.ts), and shows "away" within 60s —
--      FASTER than this ever flipped the flag, and without destroying the
--      driver's own setting. What is left for this function is genuine
--      garbage collection: the forgotten end-of-shift, where hours of silence
--      leave no real doubt.
--   2. It no longer nulls current_lat/current_lng. `last_seen_at` already
--      tells any reader how stale a position is, and "last seen here, 20
--      minutes ago" is more useful to dispatch than an empty map. Nothing
--      infers offline-ness from a null coordinate: every driver-map read site
--      (mobile PassengerHomeScreen, dashboard renderDriverMarkers) filters on
--      is_active, which this still clears.
--   3. It returns WHO it reaped, not just how many, so the caller can tell
--      them. Being switched off without being told is how a driver loses a
--      shift to a bug they cannot see.
--
-- `is_active` is the driver's stated INTENT and `last_seen_at` is what we
-- OBSERVE. Deriving the display from both is what makes it safe for this
-- function to stop writing one from the other.

-- The return type changes, so CREATE OR REPLACE cannot be used. Dropping is
-- also why the grant block at the bottom is not optional — see its comment.
drop function if exists public.reap_stale_drivers(int);

create function public.reap_stale_drivers(stale_minutes int default 240)
returns table (driver_id uuid, push_token text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.drivers d
     set is_active = false
     -- current_lat/current_lng deliberately NOT nulled; see header note 2.
   where d.is_active = true
     -- NULL heartbeat is still skipped: app builds predating the heartbeat
     -- write nothing here, and a store rollout is not atomic. It is also what
     -- the seeded demo drivers have.
     and d.last_seen_at is not null
     and d.last_seen_at < now() - make_interval(mins => stale_minutes)
     -- Never reap a driver on an active ride. Their heartbeat feeds the
     -- passenger's live tracking, so a tunnel mid-fare must not flip them
     -- offline. Unchanged from the original.
     and not exists (
       select 1 from public.rides r
        where r.driver_id = d.id
          and r.status in ('assigned', 'driver_arriving', 'in_progress')
     )
  returning d.id, d.push_token;
end;
$$;

-- MUST follow every CREATE, not just the first one. A dropped-and-recreated
-- function is a NEW function as far as privileges go: Postgres grants EXECUTE
-- to PUBLIC by default AND Supabase's default privileges grant it directly to
-- anon and authenticated, so omitting this block would quietly make a
-- SECURITY DEFINER writer callable by anyone holding the app's anon key.
-- Revoking from PUBLIC alone is NOT enough — anon and authenticated hold their
-- own direct grants and must be named. This project has been bitten by that
-- three times; verify with information_schema.routine_privileges afterwards.
revoke execute on function public.reap_stale_drivers(int) from public, anon, authenticated;
grant execute on function public.reap_stale_drivers(int) to service_role;

-- Sanity check to run after applying (expects service_role, and the owner):
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'reap_stale_drivers';
