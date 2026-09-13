-- Human-readable reference for the three report tables.
--
-- Background: ReportsPage.tsx:314 prints "Report ID: ${r.id.slice(0,8)}" on the
-- Driver Incident Report PDF — the same invented-identifier pattern that made
-- send-ride-receipt collide (20260774). It is lower risk here (report volume is
-- small and these never cross a company boundary the way a receipt does), but
-- the printed page is a formal document and the number on it should be real.
--
-- All three tables get one, not just driver_reports, because all three already
-- leave the company: notify-dispatch-report and notify-technical-report both
-- email support@vellon.ca, and vellon-ops reads technical_reports directly.
-- A support conversation about "the report you filed" currently has nothing to
-- name it with.
--
-- The prefix is STORED, not added at display time. Refs are unique per table,
-- so without a prefix a support person holding "K7M4Q2" would have to search
-- three tables to find it. DR-K7M4Q2 says which one. This is the one place the
-- ride-ref convention (bare storage, formatting at display) is deliberately
-- not followed, and the reason is that a ride ref has only one table to live in.

-- ── 1. Generalise the generator ─────────────────────────────────────
-- gen_ride_ref() was never ride-specific in behaviour, only in name. Renaming
-- rather than adding a second copy: two functions emitting codes from the same
-- alphabet is exactly the kind of duplication that drifts.
create or replace function gen_short_ref()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := '0123456789BCDFGHJKMNPQRSTVWXYZ';  -- 30 chars, no vowels
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * 30)::int, 1);
  end loop;
  return result;
end;
$$;

revoke all on function gen_short_ref() from public, anon, authenticated;

-- Point the ride path at the shared generator, then retire the old name.
create or replace function assign_ride_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempts int := 0;
begin
  if new.ride_ref is not null then
    return new;
  end if;
  loop
    candidate := gen_short_ref();
    attempts := attempts + 1;
    exit when not exists (select 1 from rides where ride_ref = candidate);
    if attempts >= 20 then
      raise exception 'gen_short_ref: 20 collisions in a row — the code space is too full, widen to 7 chars';
    end if;
  end loop;
  new.ride_ref := candidate;
  return new;
end;
$$;

revoke all on function assign_ride_ref() from public, anon, authenticated;
drop function if exists gen_ride_ref();

-- ── 2. Columns ──────────────────────────────────────────────────────
-- No GRANT needed: these are columns on existing tables, and a table-level
-- grant already covers them (see supabase-default-grants-on-new-tables).
alter table driver_reports    add column if not exists report_ref text;
alter table dispatch_reports  add column if not exists report_ref text;
alter table technical_reports add column if not exists report_ref text;

-- ── 3. One shared assign trigger, parameterised by prefix ───────────
-- The table name and prefix come from TG_ARGV so all three tables share one
-- function. TG_TABLE_NAME is interpolated with format(%I), never string
-- concatenation — this runs SECURITY DEFINER and the argument comes from the
-- trigger definition, but quoting it correctly costs nothing and means a future
-- caller cannot turn it into an injection point.
create or replace function assign_report_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix    text := tg_argv[0];
  candidate text;
  taken     boolean;
  attempts  int := 0;
begin
  if new.report_ref is not null then
    return new;
  end if;
  loop
    candidate := prefix || '-' || gen_short_ref();
    attempts := attempts + 1;
    execute format('select exists (select 1 from %I where report_ref = $1)', tg_table_name)
      into taken using candidate;
    exit when not taken;
    if attempts >= 20 then
      raise exception 'assign_report_ref: 20 collisions in a row on %', tg_table_name;
    end if;
  end loop;
  new.report_ref := candidate;
  return new;
end;
$$;

revoke all on function assign_report_ref() from public, anon, authenticated;

-- ── 4. Freeze ───────────────────────────────────────────────────────
-- Reports DO get updated (status open -> resolved), so this matters more than
-- it would on an append-only table. Pins silently rather than raising, so a
-- caller that round-trips the column does not start failing.
create or replace function guard_report_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.report_ref := old.report_ref;
  return new;
end;
$$;

revoke all on function guard_report_ref() from public, anon, authenticated;

-- ── 5. Per-table wiring: backfill BEFORE the freeze trigger ─────────
-- Same ordering trap as every other freeze in this schema (20260719): install
-- the guard first and it clobbers the backfill in the same statement.
do $$
declare
  t    text;
  pfx  text;
  r    record;
  cand text;
  dup  boolean;
  n    int;
begin
  foreach t in array array['driver_reports', 'dispatch_reports', 'technical_reports'] loop
    pfx := case t
             when 'driver_reports'    then 'DR'
             when 'dispatch_reports'  then 'DP'
             when 'technical_reports' then 'TR'
           end;
    for r in execute format('select id from %I where report_ref is null', t) loop
      n := 0;
      loop
        cand := pfx || '-' || gen_short_ref();
        n := n + 1;
        execute format('select exists (select 1 from %I where report_ref = $1)', t)
          into dup using cand;
        exit when not dup;
        if n >= 20 then
          raise exception 'backfill: 20 collisions in a row on %', t;
        end if;
      end loop;
      execute format('update %I set report_ref = $1 where id = $2', t) using cand, r.id;
    end loop;

    execute format(
      'create unique index if not exists %I on %I (report_ref)',
      t || '_report_ref_key', t);
    execute format('alter table %I alter column report_ref set not null', t);

    execute format('drop trigger if exists trg_assign_report_ref on %I', t);
    execute format(
      'create trigger trg_assign_report_ref before insert on %I
         for each row execute function assign_report_ref(%L)', t, pfx);

    execute format('drop trigger if exists trg_guard_report_ref on %I', t);
    execute format(
      'create trigger trg_guard_report_ref before update on %I
         for each row execute function guard_report_ref()', t);
  end loop;
end $$;
