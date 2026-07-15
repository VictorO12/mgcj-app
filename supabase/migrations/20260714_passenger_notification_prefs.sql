-- Column addition on an existing table — no GRANT needed.
-- Passenger-controllable notification toggles. Cancellation notices are
-- always sent regardless of these prefs (safety-critical, non-toggleable).
alter table profiles
  add column if not exists notification_prefs jsonb not null default '{"ride_updates": true, "pickup_reminders": true}'::jsonb;
