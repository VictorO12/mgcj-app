-- Verification for 20260774_ride_ref.sql + 20260775_fleet_numbering.sql
--
-- A migration file in this repo is a record of INTENT, not of live state — the
-- SQL is applied by hand in the Supabase editor. Run these AFTER applying, and
-- read the expected column next to each result.

-- ─── 1. Columns exist ───────────────────────────────────────────────
select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where (table_name = 'rides'     and column_name in ('ride_ref','car_number_at_assignment'))
    or (table_name = 'drivers'   and column_name in ('car_number','driver_number'))
    or (table_name = 'companies' and column_name like '%number%')
 order by table_name, column_name;
-- expect: rides.ride_ref NOT NULL, rides.car_number_at_assignment nullable,
--         drivers.car_number + driver_number nullable, 6 companies columns.

-- ─── 2. Every ride got a ref, and they are all distinct ─────────────
select count(*) as rides,
       count(ride_ref) as with_ref,
       count(distinct ride_ref) as distinct_refs,
       min(length(ride_ref)) as min_len,
       max(length(ride_ref)) as max_len
  from rides;
-- expect: rides = with_ref = distinct_refs, min_len = max_len = 6.

-- No vowels should ever appear (the alphabet excludes A E I O U).
select count(*) as refs_containing_a_vowel
  from rides where ride_ref ~ '[AEIOU]';
-- expect: 0.

-- ─── 3. Every driver got a number, unique within their company ──────
select coalesce(d.company_id, p.company_id) as company_id,
       count(*)                              as drivers,
       count(d.driver_number)                as numbered,
       count(distinct d.driver_number)       as distinct_numbers,
       min(d.driver_number) as lowest, max(d.driver_number) as highest
  from drivers d
  left join profiles p on p.id = d.id
 group by 1;
-- expect per company: drivers = numbered = distinct_numbers, lowest = 1.

-- The counter must sit one past the highest issued number.
select c.id, c.name, c.next_driver_number, max(d.driver_number) as highest_issued
  from companies c
  left join drivers d on d.company_id = c.id
 group by c.id, c.name, c.next_driver_number;
-- expect: next_driver_number = highest_issued + 1 (or 1 if no drivers).

-- ─── 4. Indexes ─────────────────────────────────────────────────────
select indexname, indexdef from pg_indexes
 where indexname in ('rides_ride_ref_key','drivers_car_number_key','drivers_driver_number_key');
-- expect: 3 rows, all UNIQUE; the two drivers ones partial (WHERE ... NOT NULL).

-- ─── 5. Functions exist, and are not callable by anon ───────────────
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_can_call
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('gen_ride_ref','assign_ride_ref','assign_driver_number',
                     'next_car_number','guard_driver_numbering',
                     'guard_ride_fare_fields','set_ride_completed_at');
-- expect: anon_can_call = false for ALL. authed_can_call true ONLY for
-- next_car_number. "revoke from public" alone does not do this — the revoke
-- must name anon and authenticated (see definer-revoke-anon-by-name).

-- ─── 6. Triggers — count matters as much as presence ────────────────
select tgname, tgrelid::regclass as tbl,
       case tgtype::int & 28 when 4 then 'INSERT' when 16 then 'UPDATE'
                             when 20 then 'INSERT OR UPDATE' else tgtype::text end as fires_on
  from pg_trigger
 where not tgisinternal
   and tgrelid in ('rides'::regclass, 'drivers'::regclass)
 order by tbl, tgname;
-- expect on rides: trg_assign_ride_ref (INSERT), trg_guard_ride_fare_fields
--   (UPDATE), trg_ride_completed_at (UPDATE), + whatever pre-existed.
-- expect on drivers: trg_assign_driver_number (INSERT — NOT "INSERT OR
--   UPDATE"; an UPDATE hook here would re-fire on every 10s heartbeat),
--   trg_guard_driver_numbering (UPDATE).
-- There must be NO trg_guard_ride_ref and NO trg_set_ride_car_number — both
-- were folded into existing triggers rather than added alongside them.

-- ─── 7. The freeze actually holds ───────────────────────────────────
-- Returns a ROW rather than raising a NOTICE. The first version of this check
-- was a DO block whose PASS signal was `raise notice`, which the Supabase SQL
-- editor does not display — so it reported "no rows returned" on both a pass
-- and a fail, and verified nothing.
--
-- Self-cleaning: the update is reverted in the same statement chain, and the
-- freeze is what makes that revert a no-op anyway.
with target as (
  select id, ride_ref as before_ref from rides limit 1
), attempt as (
  update rides set ride_ref = 'ZZZZZZ'
   where id = (select id from target)
  returning ride_ref as after_ref
)
select t.before_ref,
       a.after_ref,
       case when a.after_ref = t.before_ref
            then 'PASS — ride_ref survived an overwrite attempt'
            else 'FAIL — ride_ref moved, the freeze is not installed'
       end as verdict
  from target t, attempt a;
-- expect: before_ref = after_ref, verdict PASS.
-- 'ZZZZZZ' is a legal code in the alphabet, so a FAIL here would also have
-- written a real value — re-run query 2 if you see one.

-- ─── 8. Receipt numbers now derive from the ref ─────────────────────
select column_name, is_nullable from information_schema.columns
 where table_name = 'ride_receipts' and column_name = 'sent_at';
-- expect: YES. send-ride-receipt now inserts the row BEFORE calling Resend,
-- so "row exists, sent_at null" is the reconcilable "we tried and it failed"
-- state. A NOT NULL here makes every receipt insert fail.

-- ═══════════════════════════════════════════════════════════════════
-- 20260777_report_refs.sql
-- ═══════════════════════════════════════════════════════════════════

-- ─── 9. Every report got a prefixed ref, unique within its table ────
select 'driver_reports' as tbl, count(*) total, count(report_ref) with_ref,
       count(distinct report_ref) distinct_refs,
       count(*) filter (where report_ref like 'DR-%') correct_prefix
  from driver_reports
union all
select 'dispatch_reports', count(*), count(report_ref), count(distinct report_ref),
       count(*) filter (where report_ref like 'DP-%') from dispatch_reports
union all
select 'technical_reports', count(*), count(report_ref), count(distinct report_ref),
       count(*) filter (where report_ref like 'TR-%') from technical_reports;
-- expect per row: total = with_ref = distinct_refs = correct_prefix.

-- ─── 10. gen_ride_ref is gone, gen_short_ref replaced it ───────────
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon',          p.oid, 'execute') as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_can_call
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('gen_ride_ref','gen_short_ref','assign_report_ref','guard_report_ref');
-- expect: NO gen_ride_ref row (dropped), gen_short_ref present, and
-- anon_can_call = false for all three that remain.

-- ─── 11. Triggers on all three report tables ───────────────────────
select tgrelid::regclass as tbl, tgname,
       case tgtype::int & 28 when 4 then 'INSERT' when 16 then 'UPDATE'
                             else tgtype::text end as fires_on
  from pg_trigger
 where not tgisinternal
   and tgname in ('trg_assign_report_ref','trg_guard_report_ref')
 order by tbl, tgname;
-- expect 6 rows: assign (INSERT) + guard (UPDATE) on each of the three tables.

-- ─── 12. The report freeze holds ───────────────────────────────────
with target as (
  select id, report_ref as before_ref from driver_reports limit 1
), attempt as (
  update driver_reports set report_ref = 'DR-ZZZZZZ'
   where id = (select id from target)
  returning report_ref as after_ref
)
select t.before_ref, a.after_ref,
       case when a.after_ref = t.before_ref
            then 'PASS — report_ref pinned'
            else 'FAIL — report_ref moved, the freeze is not installed'
       end as verdict
  from target t, attempt a;
-- expect: PASS. Returns no rows at all if driver_reports is empty, which is
-- not a pass — check count first with query 9.
