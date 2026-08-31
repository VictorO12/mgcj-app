-- Liveness rework — verify LIVE state before changing anything.
--
-- Everything below was read from migration 20260734 in the repo, which per the
-- project's own rule is a record of INTENT, not of what is deployed. Run this
-- in the SQL editor first; the design assumes each answer matches.

-- 1. The reaper as actually deployed: signature, default stale_minutes, body.
--    EXPECT: reap_stale_drivers(stale_minutes integer DEFAULT 5), and a body
--    that nulls current_lat/current_lng and skips active-ride drivers.
--    The edge function calls .rpc('reap_stale_drivers') with NO argument, so
--    the DEFAULT here is the live threshold — not any number in the repo.
select p.proname,
       pg_get_function_arguments(p.oid) as args,
       pg_get_functiondef(p.oid)        as body
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'reap_stale_drivers';

-- 2. Who can execute it. EXPECT service_role only — no anon, no authenticated,
--    no PUBLIC (the revoke-by-name trap that has bitten this project 3x).
select grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public'
   and routine_name = 'reap_stale_drivers';

-- 3. How far the heartbeat rollout actually is. This decides whether the
--    current thresholds are live-fire or still masked by NULL tolerance.
--    A large null_heartbeat count means no real driver is being filtered or
--    reaped yet, and the rework can land with the store build rather than
--    racing it.
select count(*)                                          as drivers_total,
       count(*) filter (where is_active)                 as flagged_online,
       count(*) filter (where is_active
                          and last_seen_at is null)      as null_heartbeat,
       count(*) filter (where is_active
                          and last_seen_at is not null)  as heartbeating
  from public.drivers;

-- 4. Right-now staleness distribution among drivers flagged online with a real
--    heartbeat. Anyone in the 1-5 min bucket is someone TODAY's filter has
--    already dropped from dispatch; anyone past 5 min is someone the reaper
--    would flip offline on its next 10-min tick.
--    If the 1-5 min bucket is routinely non-empty during a shift, that is the
--    backgrounding problem showing up in data rather than in argument.
select case
         when last_seen_at >= now() - interval '1 minute'  then 'a. live (<1m)'
         when last_seen_at >= now() - interval '5 minutes' then 'b. filtered, not reaped (1-5m)'
         when last_seen_at >= now() - interval '1 hour'    then 'c. reapable (5m-1h)'
         else                                                   'd. long gone (>1h)'
       end as bucket,
       count(*)
  from public.drivers
 where is_active
   and last_seen_at is not null
 group by 1
 order by 1;

-- 5. Does the partial index exist as written? (Reaper does a global scan.)
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'drivers';

-- 6. Columns on drivers — confirms last_seen_at's type and that backgrounded_at
--    does NOT already exist before the migration adds it.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'drivers'
 order by ordinal_position;
