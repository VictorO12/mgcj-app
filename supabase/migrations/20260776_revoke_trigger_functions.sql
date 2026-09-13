-- Revoke EXECUTE on the SECURITY DEFINER trigger functions from anon and
-- authenticated, BY NAME.
--
-- Found by query 5 of .claude/notes/numbering-verification.sql, which reported
-- anon_can_call = true for all five below. Two of them (guard_ride_fare_fields,
-- set_ride_completed_at) have been in that state since they were created —
-- 20260774/20260775 only CREATE OR REPLACE'd them, and REPLACE preserves
-- existing grants, so it neither caused nor fixed this.
--
-- Severity, stated honestly: LOW. A function returning `trigger` cannot
-- actually be invoked — Postgres refuses with "trigger functions can only be
-- called as triggers", and PostgREST will not expose it as an RPC. There is no
-- live hole here. It is fixed because the convention exists precisely so that
-- nobody has to re-derive that argument per function, and because the audit
-- query should come back clean or it stops being read.
--
-- "revoke from public" alone is NOT enough: Supabase default privileges grant
-- EXECUTE directly to anon and authenticated, so those two roles must be named.
-- Bitten three times before — see definer-revoke-anon-by-name.

revoke execute on function assign_ride_ref()          from public, anon, authenticated;
revoke execute on function assign_driver_number()     from public, anon, authenticated;
revoke execute on function guard_driver_numbering()   from public, anon, authenticated;
revoke execute on function guard_ride_fare_fields()   from public, anon, authenticated;
revoke execute on function set_ride_completed_at()    from public, anon, authenticated;

-- Triggers keep firing regardless: Postgres does not check EXECUTE on a
-- trigger function when firing the trigger, only when calling it directly.
