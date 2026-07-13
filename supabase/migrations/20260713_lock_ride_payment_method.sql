-- Lock `rides.payment_method` against changes from the app/dashboard.
--
-- Background: the dispatch ride editor exposed a Cash/Card toggle. Flipping a
-- ride's payment method from the client is unsafe in both directions:
--   • cash -> card strands the ride with no Stripe PaymentIntent — and
--     dispatch-booked passengers have no card on file to charge anyway;
--   • card -> cash leaves the existing authorization hanging (a ~7-day hold on
--     the passenger's card), or double-charges them if it was already captured.
-- The editor now shows the field read-only, and this trigger is the backstop so
-- no direct client write can change it either. A genuine "switch to cash & release
-- the hold" flow, if ever needed, belongs in a dedicated service-side action that
-- cancels/refunds the PaymentIntent — not a free-form field edit.
--
-- Allowed to change payment_method:
--   • service-role Edge Functions (that future dedicated action);
--   • direct DB access — SQL editor / psql, where there is no JWT so
--     auth.role() is NULL (so you can still fix a ride by hand).
-- Blocked: any request through PostgREST as a client (passenger / driver /
-- admin dashboard).

CREATE OR REPLACE FUNCTION guard_ride_payment_method()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No change → nothing to guard.
  IF NEW.payment_method IS NOT DISTINCT FROM OLD.payment_method THEN
    RETURN NEW;
  END IF;

  -- Service-role Edge Functions and direct DB access (auth.role() NULL) allowed.
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Any client request (passenger, driver, or admin dashboard) is blocked.
  RAISE EXCEPTION 'payment_method cannot be changed from the app/dashboard — use a server-side action';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ride_payment_method ON rides;
CREATE TRIGGER trg_guard_ride_payment_method
  BEFORE UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION guard_ride_payment_method();
