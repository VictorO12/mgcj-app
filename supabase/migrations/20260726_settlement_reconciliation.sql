-- Settlement reconciliation: lets dispatch see where driver_direct card
-- money actually went (rollup by settlement_route) and track manual
-- resolution of rides that need action (platform_invoiced/failed states).

-- ── Resolution tracking (per-ride, not a monthly batch) ──────────────────
alter table rides
  add column if not exists settlement_resolved_at timestamptz null,
  add column if not exists settlement_resolved_by uuid null references profiles(id);

-- ── Audit trail event type ────────────────────────────────────────────
ALTER TABLE dispatch_events DROP CONSTRAINT dispatch_events_event_type_check;
ALTER TABLE dispatch_events ADD CONSTRAINT dispatch_events_event_type_check check (event_type in (
  'ride.created',
  'ride.cancelled',
  'ride.assigned',
  'ride.reassigned',
  'ride.scheduled_modified',
  'ride.notes_added',
  'ride.fare_changed',
  'driver.suspended',
  'driver.reactivated',
  'driver.deleted',
  'driver.vehicle_updated',
  'invite.created',
  'invite.revoked',
  'discount.created',
  'discount.deactivated',
  'discount.deleted',
  'report.reviewed',
  'report.dismissed',
  'report.printed',
  'announcement.drivers',
  'announcement.passengers',
  'escalation.acknowledged',
  'export.csv',
  'export.pdf',
  'invoice.printed',
  'settings.pricing_updated',
  'settings.vehicle_class_created',
  'settings.vehicle_class_updated',
  'settings.vehicle_class_status_changed',
  'dispatch_report.submitted',
  'staff.created',
  'staff.updated',
  'staff.deactivated',
  'staff.reactivated',
  'settlement.resolved'
));

-- ── Rollup RPC — period-scoped totals by settlement_route ────────────────
-- Informational only (no resolution tracking here — that's the separate
-- Needs Attention list, deliberately NOT period-scoped since those are
-- outstanding todos, not historical stats). Invoker-rights: relies on the
-- existing RLS policy that already lets an admin/dispatcher select their
-- own company's rides -- get_my_company_id() itself is SECURITY DEFINER.
create or replace function company_settlement_rollup(p_from timestamptz, p_to timestamptz)
returns table (
  settlement_route text,
  rides_count      integer,
  total_fares      numeric
)
language sql
stable
as $$
  select
    coalesce(r.settlement_route, 'unsettled') as settlement_route,
    count(*)::int                              as rides_count,
    coalesce(sum(r.fare_final), 0)              as total_fares
  from rides r
  where r.company_id = get_my_company_id()
    and r.payment_method = 'card'
    and r.status = 'completed'
    and r.completed_at >= p_from
    and r.completed_at <  p_to
  group by r.settlement_route;
$$;

grant execute on function public.company_settlement_rollup(timestamptz, timestamptz) to authenticated;
