-- Passenger ride receipts were misnamed "invoices" — payment is already
-- captured/collected by the time this record is created (ride completion),
-- so this is a receipt, not a bill. Renaming to remove the ambiguity with
-- any future genuine B2B invoicing (e.g. monthly cash invoicing to taxi
-- companies), which is an unrelated concept.

ALTER TABLE invoices RENAME TO ride_receipts;
ALTER TABLE ride_receipts RENAME COLUMN invoice_number TO receipt_number;
