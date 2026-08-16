-- Give the cron jobs a header the gate can actually verify.
--
-- Background: requireServiceRole compared the caller's bearer token to the
-- injected SUPABASE_SERVICE_ROLE_KEY. The cron jobs send the project's LEGACY
-- service_role JWT (verified by fingerprint — identical to the key vellon-ops
-- uses against this project), but this project has the new Supabase API key
-- system enabled and the injected SUPABASE_SERVICE_ROLE_KEY is not that JWT.
-- Result: every cron-called gated function 401'd from 23:01 UTC 2026-08-15.
--
-- Re-stamping with a different key cannot work. scheduled-ride-digest and
-- sweep-held-transfers have no config.toml block, so verify_jwt defaults to
-- TRUE and the gateway rejects any non-JWT bearer before our code runs. No
-- single value satisfies the gateway and a byte-compare gate at once.
--
-- So the two concerns get two headers:
--   Authorization: Bearer <existing legacy JWT>  -> satisfies the gateway
--   x-internal-key: <INTERNAL_API_KEY>           -> satisfies requireServiceRole
--
-- The existing Authorization token is READ FROM THE JOB and carried across
-- untouched, so the service-role JWT never has to be pasted anywhere. Only the
-- new INTERNAL_API_KEY is entered below.
--
-- ORDER OF OPERATIONS (all three, in this order):
--   1. supabase secrets set INTERNAL_API_KEY=<value> --project-ref hhsqwmftrrmtodvvuyxq
--   2. deploy the four functions (they must accept the header before it arrives)
--   3. run this file
--
-- Steps 1 and 2 are additive — the old path still works — so nothing breaks
-- between them. Only step 3 changes what the cron sends.

DO $$
DECLARE
  ikey text := 'PASTE_INTERNAL_API_KEY_HERE';
  base text := 'https://hhsqwmftrrmtodvvuyxq.supabase.co/functions/v1/';
  j    record;
  jwt  text;
BEGIN
  -- Shape check only. Deliberately does not compare against the placeholder
  -- string: having that literal appear twice in an earlier version of this
  -- migration invited pasting the key over both copies, which made the guard
  -- compare the key to itself and abort. One paste point, shape-checked.
  IF length(ikey) < 32 THEN
    RAISE EXCEPTION 'INTERNAL_API_KEY looks wrong: expected 32+ chars, got %', length(ikey);
  END IF;

  FOR j IN
    SELECT jobid, jobname, command FROM cron.job
     WHERE jobname IN (
       'expire-pending-rides',
       'scheduled-coverage-monitor',
       'sweep-held-transfers',
       'scheduled-ride-digest'
     )
  LOOP
    jwt := substring(j.command from 'Bearer ([A-Za-z0-9_.\-]+)');

    IF jwt IS NULL THEN
      RAISE EXCEPTION 'no bearer token found in job % — inspect it by hand', j.jobname;
    END IF;

    PERFORM cron.alter_job(
      job_id  := j.jobid,
      command := format(
        $cmd$SELECT net.http_post(
          url     := %L,
          headers := %L::jsonb,
          body    := '{}'::jsonb
        )$cmd$,
        base || j.jobname,
        json_build_object(
          'Content-Type',   'application/json',
          'Authorization',  'Bearer ' || jwt,
          'x-internal-key', ikey
        )::text
      )
    );

    RAISE NOTICE 're-stamped %', j.jobname;
  END LOOP;
END $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 1. All four jobs should now carry the new header, and their Authorization
--    token should be UNCHANGED (same md5 as the untouched jobs):
--
--   SELECT jobname,
--          command LIKE '%x-internal-key%' AS has_internal_key,
--          md5(substring(command from 'Bearer ([A-Za-z0-9_.\-]+)')) AS jwt_md5
--     FROM cron.job ORDER BY jobname;
--
-- 2. Within ~2 minutes the every-minute 401 (expire-pending-rides) should stop.
--    This should return ZERO rows:
--
--   SELECT status_code, content, created FROM net._http_response
--    WHERE status_code = 401 AND created > now() - interval '3 minutes';
--
-- 3. The digest reports its own summary on the next */15 tick:
--
--   SELECT content, created FROM net._http_response
--    WHERE content LIKE '%open_rides_in_horizon%' ORDER BY created DESC LIMIT 3;
