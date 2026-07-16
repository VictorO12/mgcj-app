-- Dispatcher-only staff management model.
--
-- Admins manage DISPATCHERS only (add/edit/deactivate). Admin accounts are a
-- vendor-managed seat (provisioned by Vellon via service role / SQL), because:
--   • small operators need only 1-2 admins, so it's rare;
--   • it removes every admin-on-admin hazard at once — no coup (one admin
--     deactivating the owner), no mutual lockout, no last-admin lockout,
--     no self-demotion.
--
-- This tightens the earlier "admins can manage staff account status" policy
-- (which let an admin write ANY admin/dispatcher row) down to dispatcher rows
-- only. Service-role (Vellon's manual admin provisioning) bypasses RLS, so it
-- is unaffected.

DROP POLICY IF EXISTS "admins can manage staff account status" ON profiles;
CREATE POLICY "admins can manage dispatcher account status"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    get_my_role() = 'admin'
    AND role = 'dispatcher'
    AND company_id = get_my_company_id()
  )
  WITH CHECK (
    get_my_role() = 'admin'
    AND role = 'dispatcher'
    AND company_id = get_my_company_id()
  );

-- Add staff.updated (dispatcher name/phone edits) to the audit event types.
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
  'staff.reactivated'
));
