-- Diagnose: ride_reviews rows exist but neither history screen shows a rating.
-- Run whole file in the Supabase SQL editor.

-- 1. What policies actually exist live on ride_reviews?
select policyname, cmd, roles, qual, with_check
from pg_policies
where tablename = 'ride_reviews'
order by cmd, policyname;

-- 2. Table privileges (a missing GRANT looks exactly like RLS filtering).
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'ride_reviews' and table_schema = 'public';

-- 3. Column privileges on the columns the app selects.
select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_name = 'ride_reviews' and table_schema = 'public'
  and column_name in ('rating','ride_id','driver_id','passenger_id')
order by grantee, column_name;

-- 4. Simulate the two real reads. Pick one review that exists:
--    (run this first, copy the ids into the blocks below)
select id, ride_id, driver_id, passenger_id, rating
from ride_reviews
order by created_at desc
limit 5;

-- 5. Self-driving RLS simulation: takes the most recent review, then re-reads
--    it as that ride's driver and as its passenger, exactly the way PostgREST
--    would. Reads only.
DO $$
DECLARE
  v_ride uuid; v_driver uuid; v_pass uuid;
  n_direct int; n_embed int;
BEGIN
  SELECT ride_id, driver_id, passenger_id
    INTO v_ride, v_driver, v_pass
  FROM ride_reviews ORDER BY created_at DESC LIMIT 1;
  RAISE NOTICE 'review ride=% driver=% passenger=%', v_ride, v_driver, v_pass;

  -- as the driver
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  EXECUTE 'set local role authenticated';
  RAISE NOTICE '  auth.uid()=%  auth.role()=%', auth.uid(), auth.role();
  SELECT count(*) INTO n_direct FROM ride_reviews WHERE driver_id = v_driver;
  SELECT count(*) INTO n_embed  FROM ride_reviews WHERE ride_id  = v_ride;
  RESET ROLE;
  RAISE NOTICE 'as DRIVER: own reviews visible=%  this ride visible=%', n_direct, n_embed;

  -- as the passenger
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_pass, 'role', 'authenticated')::text, true);
  EXECUTE 'set local role authenticated';
  RAISE NOTICE '  auth.uid()=%  auth.role()=%', auth.uid(), auth.role();
  SELECT count(*) INTO n_direct FROM ride_reviews WHERE passenger_id = v_pass;
  SELECT count(*) INTO n_embed  FROM ride_reviews WHERE ride_id = v_ride;
  RESET ROLE;
  RAISE NOTICE 'as PASSENGER: own reviews visible=%  this ride visible=%', n_direct, n_embed;
END $$;
