-- Add ride.created to the allowed event types for dispatcher activity log.
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
  ));
