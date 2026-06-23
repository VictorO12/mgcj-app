-- Verification script for the deferred-PaymentIntent fix on scheduled card rides.
-- Run each step's queries in order in the Supabase SQL editor.
-- Uses a temp test ride so it's easy to clean up at the end (Step 6).

-- ─────────────────────────────────────────────────────────────────
-- STEP 0: Find a passenger with a saved card, and an online driver,
-- both in the same company. You need both ids below for Step 1.
-- ─────────────────────────────────────────────────────────────────
select p.id as passenger_id, p.name, p.company_id, p.stripe_customer_id,
       pm.id as payment_method_id, pm.stripe_payment_method_id, pm.is_default
from profiles p
join payment_methods pm on pm.passenger_id = p.id
where p.role = 'passenger' and p.stripe_customer_id is not null
order by pm.is_default desc;

select id as driver_id, name, company_id
from profiles
where role = 'driver';

-- ─────────────────────────────────────────────────────────────────
-- STEP 1: Insert a test scheduled ride, card payment, scheduled
-- ~50 minutes out (inside the 65-min scheduled-lifecycle window so
-- the very next cron/manual invocation will pick it up), already
-- "claimed" by the driver (driver_id set, confirmed_by_driver true)
-- so handleClaimed() — not handleUnclaimed() — runs.
--
-- Replace <PASSENGER_ID>, <COMPANY_ID>, <PAYMENT_METHOD_ID>, <DRIVER_ID>
-- with real values from Step 0.
-- ─────────────────────────────────────────────────────────────────
insert into rides (
  passenger_id, company_id, driver_id, confirmed_by_driver,
  status, pickup_address, pickup_lat, pickup_lng,
  dropoff_address, dropoff_lat, dropoff_lng,
  fare_estimate, payment_method, payment_method_id,
  stripe_payment_intent_id, payment_status, scheduled_at
) values (
  '<PASSENGER_ID>', '<COMPANY_ID>', '<DRIVER_ID>', true,
  'scheduled', '123 Test St, Kentville, NS', 45.0778, -64.4983,
  '456 Test Ave, New Minas, NS', 45.0833, -64.4333,
  18.50, 'card', '<PAYMENT_METHOD_ID>',
  null, 'pending', now() + interval '50 minutes'
)
returning id, status, payment_status, stripe_payment_intent_id, scheduled_at;

-- Confirm immediately: should show stripe_payment_intent_id = null,
-- payment_status = 'pending' — i.e. no PaymentIntent created at
-- "booking" (this mirrors what the real booking insert in
-- PassengerHomeScreen.tsx now does for scheduled card rides).
select id, status, payment_status, stripe_payment_intent_id, scheduled_at
from rides
where pickup_address = '123 Test St, Kentville, NS'
order by created_at desc
limit 1;

-- ─────────────────────────────────────────────────────────────────
-- STEP 2: Now go invoke the deployed scheduled-lifecycle function.
-- From a terminal (not the SQL editor):
--
--   supabase functions invoke scheduled-lifecycle --project-ref hhsqwmftrrmtodvvuyxq
--
-- Then check the function logs in the Supabase dashboard
-- (Edge Functions → scheduled-lifecycle → Logs) for a line like:
--   "[ride <id>] deferred PaymentIntent created: pi_..."
-- and confirm no errors.
-- ─────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────
-- STEP 3: Re-check the ride row after the invocation. Expect
-- stripe_payment_intent_id to now be a real "pi_..." id, and
-- payment_status still 'pending' (not 'failed').
-- ─────────────────────────────────────────────────────────────────
select id, status, payment_status, stripe_payment_intent_id, notified_30min, scheduled_at
from rides
where pickup_address = '123 Test St, Kentville, NS'
order by created_at desc
limit 1;

-- ─────────────────────────────────────────────────────────────────
-- STEP 4: Take the stripe_payment_intent_id from Step 3 and look it
-- up in the Stripe dashboard (test mode) → Payments, or via:
--   curl https://api.stripe.com/v1/payment_intents/pi_xxx \
--     -u sk_test_xxx:
-- Confirm: status = "requires_capture", amount = 1850 (cents),
-- currency = "cad".
-- ─────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────
-- STEP 5 (negative case, optional): repeat Steps 1-3 but pass a
-- payment_method_id that doesn't exist / belongs to a passenger
-- with no stripe_customer_id, to confirm the failure path: expect
-- payment_status = 'failed' and a push notification attempt logged
-- (check function logs for "no saved card found for deferred
-- PaymentIntent" or "deferred PaymentIntent failed").
-- ─────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────
-- STEP 6: Cleanup — delete the test ride(s) when done.
-- ─────────────────────────────────────────────────────────────────
delete from rides where pickup_address = '123 Test St, Kentville, NS';
