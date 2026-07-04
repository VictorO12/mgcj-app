-- Add resolution_notes to driver_reports so dispatchers can record
-- what action was taken when reviewing or dismissing a report.
alter table driver_reports
  add column if not exists resolution_notes text;
