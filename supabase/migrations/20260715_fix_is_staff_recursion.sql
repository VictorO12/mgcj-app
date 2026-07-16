-- Fix 42P17 infinite_recursion on profiles SELECT, introduced by
-- 20260715_dispatcher_role_split.sql's is_staff() helper.
--
-- is_staff() was written as `LANGUAGE sql STABLE`. Simple one-line SQL
-- functions like that are eligible for planner inlining -- the body gets
-- substituted directly into the RLS policy expression rather than called
-- as an opaque function. When inlined, SECURITY DEFINER has no real
-- function-call boundary to attach to at execution time, and Postgres's
-- RLS recursion guard sees what looks like a self-referential profiles
-- policy and raises infinite_recursion.
--
-- get_my_role() never hit this because it's LANGUAGE plpgsql -- plpgsql
-- functions are opaque to the planner and can never be inlined, so the
-- SECURITY DEFINER bypass is always genuinely applied. Matching that
-- pattern here fixes it.

CREATE OR REPLACE FUNCTION is_staff()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN get_my_role() IN ('admin', 'dispatcher');
END;
$$;
