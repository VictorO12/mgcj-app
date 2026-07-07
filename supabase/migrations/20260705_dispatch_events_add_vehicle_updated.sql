-- Add driver.vehicle_updated to the allowed event types.
alter table dispatch_events
  drop constraint dispatch_events_event_type_check;

alter table dispatch_events
  add constraint dispatch_events_event_type_check check (event_type in (
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
    'settings.pricing_updated'
  ));
