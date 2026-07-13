-- Freeze the money columns on `rides` against passenger/driver tampering.
--
-- Background: fare_estimate / pre_discount_fare / discount_amount / discount_type
-- are set at booking. RLS lets a passenger UPDATE their own ride rows and can
-- only gate *rows*, not *columns* — so a passenger could rewrite fare_estimate
-- (e.g. down to $0.75) after booking. The charge is now sized server-side from
-- the PaymentIntent, but these stored values still feed receipts, ride history,
-- cash invoicing and revenue analytics, so they must stay honest too.
--
-- This BEFORE UPDATE trigger rejects any change to those columns by a passenger
-- or driver. It intentionally allows:
--   • service-role Edge Functions (auth.role() = 'service_role') — they
--     recompute and write the authoritative fare (scheduled-release,
--     capture-payment);
--   • dispatch admins (get_my_role() = 'admin') — editing a ride's fare is a
--     normal dispatch workflow, already scoped to their own company by RLS.
--
-- fare_final is deliberately NOT frozen: the driver sets it on cash rides
-- (bounded by the cash_fare_final_range constraint), and capture-payment
-- overwrites it server-side for card rides.

CREATE OR REPLACE FUNCTION guard_ride_fare_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Edge Functions (service_role) and direct DB access (SQL editor / psql /
  -- cron, where there is no JWT so auth.role() is NULL) are always allowed.
  -- The NULL arm is what lets you still fix a ride by hand in the SQL editor.
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Dispatch admins: allowed (RLS already scopes them to their own company).
  IF get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  -- Everyone else (passengers, drivers): the money columns are read-only.
  IF NEW.fare_estimate      IS DISTINCT FROM OLD.fare_estimate
     OR NEW.pre_discount_fare IS DISTINCT FROM OLD.pre_discount_fare
     OR NEW.discount_amount   IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_type     IS DISTINCT FROM OLD.discount_type THEN
    RAISE EXCEPTION 'Fare fields are read-only';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ride_fare_fields ON rides;
CREATE TRIGGER trg_guard_ride_fare_fields
  BEFORE UPDATE ON rides
  FOR EACH ROW
  EXECUTE FUNCTION guard_ride_fare_fields();
