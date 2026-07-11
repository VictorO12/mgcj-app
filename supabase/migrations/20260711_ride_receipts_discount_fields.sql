-- Surface discount breakdown (original fare, discount amount, discount label)
-- on the receipt record so both the passenger email/PDF and the dispatch
-- dashboard can show what was discounted, not just the final fare.

ALTER TABLE ride_receipts
  ADD COLUMN pre_discount_fare numeric(10,2),
  ADD COLUMN discount_amount numeric(10,2),
  ADD COLUMN discount_label text;
