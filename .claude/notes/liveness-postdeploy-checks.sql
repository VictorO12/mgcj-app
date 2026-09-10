-- Post-deploy verification for 20260766 + the three redeployed functions.
-- Run 10+ minutes after deploying so both crons have ticked at least once.

-- 1. THE IMPORTANT ONE: did the redeployed crons actually return 200?
--
-- cron.job_run_details reports SUCCESS regardless — net.http_post only has to
-- ENQUEUE the request, so a function that 500s on an import error or a type
-- error looks identical to one that worked. The HTTP status lands here and
-- nowhere else, and nothing reads this table on its own.
--
-- scheduled-release runs every 2 min, scheduled-coverage-monitor every 10 min.
-- There is no job column, so attribute rows by response-body shape.
select id,
       created,
       status_code,
       left(content, 200) as body
  from net._http_response
 where created > now() - interval '30 minutes'
 order by created desc
 limit 40;

-- Anything that is not 200 is the deploy breaking something. A 401 means the
-- internal-auth headers, not this change.

-- 2. The reaper's new signature is live and returns ROWS, not a count.
--    A huge threshold matches nobody, so this reaps nothing — it only proves
--    the function resolves and its shape is right. Expect 0 rows, no error.
select * from public.reap_stale_drivers(100000);

-- 3. Confirm the relaxed threshold is the DEFAULT, since the edge function
--    calls .rpc() with no argument and therefore inherits it.
--    EXPECT: stale_minutes integer DEFAULT 240
select pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'reap_stale_drivers';

-- 4. Nobody was reaped by the old 5-minute rule on its way out, and no
--    location got nulled. Drivers still flagged online, with their heartbeat
--    age and whether they still have coordinates.
select p.name,
       d.is_active,
       round(extract(epoch from (now() - d.last_seen_at))/60) as mins_since_beat,
       (d.current_lat is not null)                            as has_position,
       (d.push_token is not null)                             as pushable
  from public.drivers d
  left join public.profiles p on p.id = d.id
 where d.is_active
 order by d.last_seen_at desc nulls last;
