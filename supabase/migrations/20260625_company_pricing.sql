-- Add configurable fare pricing to companies table.
-- Defaults match the previously hardcoded values ($4 base + $1.80/km).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS base_fare   numeric(10, 2) NOT NULL DEFAULT 4.00,
  ADD COLUMN IF NOT EXISTS rate_per_km numeric(10, 4) NOT NULL DEFAULT 1.80;
