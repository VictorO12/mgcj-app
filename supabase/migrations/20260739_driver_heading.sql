-- Driver travel heading (GPS course), in degrees clockwise from true north.
-- Written on the same UPDATE as current_lat/current_lng/last_seen_at by the
-- mobile heartbeat, so `last_seen_at` doubles as this column's freshness stamp.
--
-- NULL is meaningful and there is deliberately NO backfill: a driver on an app
-- build that predates the heartbeat change never writes it, and the passenger
-- map falls back to a bearing derived from consecutive positions for those. A
-- backfill would stamp every existing driver with a fixed wrong angle.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS heading real;

COMMENT ON COLUMN drivers.heading IS
  'GPS course in degrees clockwise from true north (0-360). NULL = unknown; client derives bearing from position deltas instead.';
