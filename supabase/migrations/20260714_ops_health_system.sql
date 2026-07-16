-- Ops-health reader for the Vellon Ops console (DB / Ops health module).
--
-- The console reads mgcj with the service role, but PostgREST only exposes the
-- `public` schema — so cron.* and net.* (pg_cron run history, pg_net HTTP
-- responses) are unreachable directly. This single SECURITY DEFINER function,
-- owned by `postgres` (which has SELECT on both system schemas — same role the
-- SQL editor runs as, and the one used to prune those tables), returns one JSON
-- blob of everything the console needs from those schemas. One function → one
-- EXECUTE grant → one thing to apply.
--
-- SECURITY DEFINER + an explicit search_path is the documented-safe pattern and
-- keeps Supabase's linter happy (mirrors get_my_role / get_my_company_id).

create or replace function public.ops_health_system()
returns jsonb
language sql
security definer
set search_path = public, cron, net
stable
as $$
  select jsonb_build_object(
    -- ── pg_cron: each job + its most recent run ────────────────────
    'cron', coalesce((
      select jsonb_agg(j order by j->>'jobname')
      from (
        select jsonb_build_object(
          'jobid',        job.jobid,
          'jobname',      job.jobname,
          'schedule',     job.schedule,
          'active',       job.active,
          'last_run',     d.last_run,
          'last_status',  d.last_status,
          'failures_24h', d.failures_24h
        ) as j
        from cron.job job
        left join lateral (
          select
            max(r.start_time) as last_run,
            (array_agg(r.status order by r.start_time desc))[1] as last_status,
            count(*) filter (
              where r.status = 'failed'
                and r.start_time > now() - interval '24 hours'
            ) as failures_24h
          from cron.job_run_details r
          where r.jobid = job.jobid
        ) d on true
      ) jobs
    ), '[]'::jsonb),

    -- ── Internal-table bloat: row count IS the liveness signal for the
    -- nightly cleanup-cron-logs job (it caps these at ~3 days). A count far
    -- above ~3 days of runs means that cleanup job has died. ────────────
    'bloat', jsonb_build_object(
      'job_run_details_rows',   (select count(*) from cron.job_run_details),
      'job_run_details_oldest', (select min(start_time) from cron.job_run_details),
      'http_response_rows',     (select count(*) from net._http_response),
      'http_response_oldest',   (select min(created) from net._http_response)
    ),

    -- ── pg_net HTTP responses: proxy for edge-function invocation health
    -- (the cron→function calls). Non-2xx = a function call that errored. ──
    'http', jsonb_build_object(
      'total_24h', (select count(*) from net._http_response
                      where created > now() - interval '24 hours'),
      'failed_24h', (select count(*) from net._http_response
                      where created > now() - interval '24 hours'
                        and (status_code is null or status_code < 200 or status_code >= 300)),
      'total_1h', (select count(*) from net._http_response
                     where created > now() - interval '1 hour'),
      'failed_1h', (select count(*) from net._http_response
                     where created > now() - interval '1 hour'
                       and (status_code is null or status_code < 200 or status_code >= 300))
    )
  );
$$;

-- Least privilege: only the service role (used by the Vellon Ops server) may run it.
revoke all on function public.ops_health_system() from public;
grant execute on function public.ops_health_system() to service_role;
