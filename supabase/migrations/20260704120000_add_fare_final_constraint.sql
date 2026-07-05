-- Prevent drivers from submitting fraudulent fare_final on cash rides
ALTER TABLE rides
  ADD CONSTRAINT cash_fare_final_range
  CHECK (
    payment_method != 'cash'
    OR fare_final IS NULL
    OR (fare_final >= fare_estimate * 0.9 AND fare_final <= fare_estimate + 5)
  );
