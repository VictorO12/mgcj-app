-- Driver "On my way" signal for scheduled rides.
--
-- A driver can start working a scheduled ride well before its scheduled_at:
-- they tap "On my way" on the countdown card and drive to the pickup. Until
-- now that was local-only state on the driver's device, so the passenger app
-- and the dispatch dashboard had no way to know — both gated "is this ride
-- live?" purely on `scheduled_at > now()`, which left the passenger with no
-- tracking sheet and made the ride disappear from the dashboard once the
-- driver marked arrival ahead of the booked time.
--
-- Deliberately NOT a status change: `driver_arriving` means "arrived at the
-- pickup" everywhere else (passenger push copy, driver button labels), so
-- reusing it would falsely tell the passenger the driver is already there and
-- skip the driver's own arrival step.
--
-- UI-only field: no freeze trigger (it drives no money), and no GRANTs needed
-- since this is a column add on an existing, already-exposed table.
alter table public.rides
  add column if not exists en_route_at timestamptz;

comment on column public.rides.en_route_at is
  'Set when the driver taps "On my way" for a scheduled ride. Marks the ride as live for the passenger app and dispatch dashboard before scheduled_at arrives. Null for rides the driver has not departed for.';
