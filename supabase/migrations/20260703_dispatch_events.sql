-- Dispatcher activity log for accountability.
-- Records intentional actions taken by authenticated admin users.
-- System/automated events are excluded by design — those are traceable via
-- ride status transitions and edge function logs.

create table dispatch_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  dispatcher_id  uuid not null references profiles(id),
  ride_id        uuid references rides(id),
  event_type     text not null check (event_type in (
    'ride.cancelled',
    'ride.assigned',
    'ride.reassigned',
    'ride.scheduled_modified',
    'ride.notes_added',
    'ride.fare_changed',
    'driver.suspended',
    'driver.reactivated',
    'driver.deleted',
    'invite.created',
    'invite.revoked',
    'discount.created',
    'discount.deactivated',
    'discount.deleted',
    'report.reviewed',
    'announcement.drivers',
    'announcement.passengers',
    'escalation.acknowledged',
    'export.csv',
    'export.pdf'
  )),
  details        jsonb not null default '{}',
  created_at     timestamptz not null default now()
);

-- Dispatchers read their own company's events only.
-- Inserts are allowed for authenticated admins (enforced via RLS, not just app logic).
alter table dispatch_events enable row level security;

create policy "Dispatchers can read own company events"
  on dispatch_events for select
  using (company_id = get_my_company_id());

create policy "Dispatchers can insert own company events"
  on dispatch_events for insert
  with check (
    company_id = get_my_company_id()
    and dispatcher_id = auth.uid()
    and get_my_role() = 'admin'
  );

-- No update or delete — the log is append-only by policy.

grant select, insert on dispatch_events to authenticated;
grant all on dispatch_events to service_role;

-- Index for the most common dashboard queries: company feed and per-ride timeline.
create index dispatch_events_company_created
  on dispatch_events (company_id, created_at desc);

create index dispatch_events_ride
  on dispatch_events (ride_id)
  where ride_id is not null;
