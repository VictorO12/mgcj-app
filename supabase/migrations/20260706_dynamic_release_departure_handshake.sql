-- Dynamic release timing + departure handshake schema additions.
-- leave_by: when the accepting driver should physically depart (stamped at offer time).
-- departure_notified: guard so the departure push fires exactly once per ride.
-- pickup_eta_mins: drive-time in minutes for the offered driver (display / debug).

-- Column additions on an existing table — no GRANT needed.
-- rides' table-level grants were set at creation and cover new columns automatically.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS leave_by            timestamptz NULL,
  ADD COLUMN IF NOT EXISTS departure_notified  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pickup_eta_mins     integer     NULL;
