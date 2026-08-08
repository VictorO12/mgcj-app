-- Passenger-facing driver profile card (tapping a car on the passenger map).
--
-- Why an RPC and not a direct query: the "profiles select policy"
-- (20260715_inline_staff_check_in_rls.sql) only lets a passenger read another
-- user's profiles row if the two have SHARED A RIDE. Tapping an *ambient*
-- driver on the map therefore returned nothing for name/avatar, and the sheet
-- degraded to just vehicle make + plate. Loosening that policy is the wrong
-- fix — RLS gates rows, not columns, so it would expose the driver's phone
-- number and company along with their name.
--
-- This definer function returns only the fields a passenger is meant to see,
-- and folds the old N+1 (one profiles query per review) into a single call.
CREATE OR REPLACE FUNCTION public.driver_public_profile(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  -- Drivers never see review comments (their own or anyone's) — they get the
  -- star average only. Dispatch reads comments on the dashboard.
  hide_comments boolean := false;
BEGIN
  -- Guarded so the function is still testable from the SQL editor, where there
  -- is no JWT for get_my_role() to read.
  BEGIN
    hide_comments := (get_my_role() = 'driver');
  EXCEPTION WHEN OTHERS THEN
    hide_comments := false;
  END;

  SELECT jsonb_build_object(
    'name', p.name,
    'avatar_url', p.avatar_url,
    'vehicle_make', d.vehicle_make,
    'vehicle_model', d.vehicle_model,
    'plate_number', d.plate_number,
    'average_rating', agg.avg_rating,
    'review_count', COALESCE(agg.review_count, 0),
    'rating_counts', COALESCE(stars.rating_counts, '{}'::jsonb),
    'reviews', COALESCE(rev.list, '[]'::jsonb)
  )
  INTO result
  FROM profiles p
  LEFT JOIN drivers d ON d.id = p.id
  -- Aggregates run over ALL reviews, not just the page of recent ones below.
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
           COUNT(*)                         AS review_count
    FROM ride_reviews r
    WHERE r.driver_id = p_driver_id
  ) agg ON TRUE
  -- Per-star tallies for the breakdown bars, e.g. {"5": 12, "4": 3}.
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(s.rating::text, s.n) AS rating_counts
    FROM (
      SELECT r.rating, COUNT(*) AS n
      FROM ride_reviews r
      WHERE r.driver_id = p_driver_id
      GROUP BY r.rating
    ) s
  ) stars ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'id', t.id,
               'rating', t.rating,
               'comment', CASE WHEN hide_comments THEN NULL ELSE t.comment END,
               'created_at', t.created_at,
               -- First name only: this endpoint is readable by any signed-in
               -- user, and a reviewer's surname isn't needed to show a review.
               'passenger_name', NULLIF(split_part(COALESCE(pp.name, ''), ' ', 1), ''),
               'passenger_avatar_url', pp.avatar_url
             )
             ORDER BY t.created_at DESC
           ) AS list
    FROM (
      SELECT r.id, r.rating, r.comment, r.created_at, r.passenger_id
      FROM ride_reviews r
      WHERE r.driver_id = p_driver_id
      ORDER BY r.created_at DESC
      LIMIT 20
    ) t
    LEFT JOIN profiles pp ON pp.id = t.passenger_id
  ) rev ON TRUE
  WHERE p.id = p_driver_id;

  RETURN result;
END;
$$;

-- Definer functions are reachable by anon/authenticated through PostgREST via
-- Supabase's default privileges, so a bare `REVOKE ... FROM public` is not
-- enough — revoke from the roles by name, then grant back only what's wanted.
-- `authenticated` is intentional here (anonymous guest-booking sessions are
-- authenticated users), `anon` is not.
REVOKE EXECUTE ON FUNCTION public.driver_public_profile(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.driver_public_profile(uuid) TO authenticated;
