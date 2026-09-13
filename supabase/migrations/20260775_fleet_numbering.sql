-- Human-readable fleet identity: a car number and a driver number, both
-- per-company, both formatted to whatever convention the company already uses.
--
-- These two look like one feature and behave oppositely, which is the whole
-- design:
--
--                  car_number                    driver_number
--   names          a reassignable SLOT           a person's RECORD
--   generation     lowest unused                 monotonic counter
--   reuse          yes (Car 7 retires,           NEVER
--                  next driver is Car 7)
--   editable       freely                        admin correction only
--   ride snapshot  REQUIRED                      not needed
--
-- The snapshot row is the payoff. rides.driver_id is already on every ride and
-- never moves, and because a driver number is never reused it stays 1:1 with
-- that UUID forever — so a join resolves "who was Driver 14 in March"
-- correctly with no extra column. A car number gets reassigned, so the same
-- join would answer with whoever holds Car 7 TODAY. Hence
-- rides.car_number_at_assignment, frozen, and no driver equivalent. Same
-- reasoning as completed_at (20260718) and platform_fee_percent_at_completion
-- (20260719), reached twice before by getting it wrong.

-- ── 1. Per-company formatting config ────────────────────────────────
-- Three concrete fields per entity, deliberately NOT a format-string DSL:
-- dispatch would get a mini-language wrong and support would own it forever.
-- Prefix is optional — a company that paints bare numbers on its roofs (as
-- Casino Taxi does) leaves it empty with pad 0 and gets 1, 2, 47.
-- Cars and drivers get SEPARATE settings: bare numbers for cars and "D-" for
-- drivers is the common case.
alter table companies
  add column if not exists car_number_prefix    text    not null default '',
  add column if not exists car_number_pad       int     not null default 0,
  add column if not exists car_number_start     int     not null default 1,
  add column if not exists driver_number_prefix text    not null default '',
  add column if not exists driver_number_pad    int     not null default 0,
  add column if not exists next_driver_number   int     not null default 1;

-- ── 2. Columns on drivers ───────────────────────────────────────────
-- car_number is TEXT: it stores what is actually painted on the car, and
-- dispatch can override with anything (12A is a real convention). The
-- suggestion helper below only reasons about the purely-numeric ones.
-- driver_number is INT: it is system-issued from the counter, so the prefix
-- and padding are pure display formatting applied on top.
alter table drivers
  add column if not exists car_number    text,
  add column if not exists driver_number int;

-- Per-company uniqueness. Partial, so the many un-numbered rows don't collide
-- on NULL. lower() on car_number because "7a" and "7A" are the same car.
create unique index if not exists drivers_car_number_key
  on drivers (company_id, lower(car_number))
  where car_number is not null;

create unique index if not exists drivers_driver_number_key
  on drivers (company_id, driver_number)
  where driver_number is not null;

-- ── 3. Assign driver_number ─────────────────────────────────────────
-- Fires on INSERT *and* UPDATE, and resolves company_id two ways, because the
-- signup path does not supply one: OTPVerifyScreen.tsx:162 upserts drivers as
-- {id, is_active:false} while company_id lives on the profiles row written
-- just above it. So on insert we fall back to profiles, and if the company is
-- genuinely unknown at that moment we leave the number NULL and pick it up on
-- the first UPDATE that resolves a company.
--
-- Assignment happens at OTP verify, NOT at vehicle setup: a driver who
-- consumed a valid invite and verified an OTP is on the roster already. Tying
-- it to DriverSetupScreen completion would mean the driver stuck mid-onboarding
-- is precisely the one support cannot refer to by number.
--
-- That upsert uses onConflict:"id" and can run twice for the same user, which
-- is why the number is issued here and not in application code — the
-- `is not null` guard makes a second pass a no-op instead of burning a number.
create or replace function assign_driver_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_company uuid;
begin
  if new.driver_number is not null then
    return new;
  end if;

  resolved_company := new.company_id;
  if resolved_company is null then
    select company_id into resolved_company from profiles where id = new.id;
  end if;

  if resolved_company is null then
    return new;  -- no company yet; a later update will assign it
  end if;

  -- Atomic: the UPDATE takes a row lock on the company, so two concurrent
  -- driver signups cannot be handed the same number.
  update companies
     set next_driver_number = next_driver_number + 1
   where id = resolved_company
  returning next_driver_number - 1 into new.driver_number;

  return new;
end;
$$;

drop trigger if exists trg_assign_driver_number on drivers;
create trigger trg_assign_driver_number
  before insert on drivers
  for each row
  execute function assign_driver_number();

-- INSERT-only, deliberately. `drivers` is the hottest-written table in the
-- schema — DriverHomeScreen writes current_lat/current_lng/last_seen_at every
-- ~10s per online driver. A BEFORE UPDATE hook here would re-enter this
-- function 6 times a minute per driver, and for any driver whose number is
-- still NULL it would re-run the profiles lookup every time AND take a row
-- lock on `companies`, serialising every heartbeat at that company behind one
-- row. The one-shot repair for already-existing rows is §4 below, not a
-- permanent UPDATE hook.

-- ── 4. Backfill every existing driver ───────────────────────────────
-- Ordered by profile creation, so the longest-serving driver is #1 — the order
-- a company would have used itself. Runs BEFORE the guard trigger below, same
-- trap as always: the guard would reject these writes.
do $$
declare
  c record;
  d record;
  n int;
begin
  for c in select id from companies loop
    select next_driver_number into n from companies where id = c.id;
    for d in
      select dr.id
        from drivers dr
        join profiles p on p.id = dr.id
       where dr.driver_number is null
         and coalesce(dr.company_id, p.company_id) = c.id
       order by p.created_at asc, dr.id asc
    loop
      update drivers set driver_number = n where id = d.id;
      n := n + 1;
    end loop;
    update companies set next_driver_number = n where id = c.id;
  end loop;
end $$;

-- ── 5. Suggest the lowest unused car number ─────────────────────────
-- Lowest-unused, NOT a counter: a counter hands out Car 48 while 7, 12 and 30
-- sit empty, which is wrong for a fleet that thinks in cars rather than hires.
-- Returns the integer; the caller renders prefix + padding around it.
-- Non-numeric car numbers (12A) simply don't participate.
create or replace function next_car_number(p_company_id uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  start_at int;
  prefix   text;
  taken    int[];
  n        int;
begin
  -- SECURITY DEFINER with a company_id parameter: without this check any
  -- authenticated session could probe another company's car-number density.
  -- Same shape as the companies_select leak closed in 20260745.
  if p_company_id is distinct from get_my_company_id() then
    raise exception 'next_car_number: not your company';
  end if;

  select car_number_start, car_number_prefix
    into start_at, prefix
    from companies where id = p_company_id;

  if start_at is null then
    return 1;
  end if;

  -- Only PURELY numeric car numbers participate. A company using "12A" keeps
  -- it, but it is not a candidate for "lowest unused" — stripping non-digits
  -- would make 12A collide with a plain 12 and silently skip a free number.
  -- left()/= rather than ilike: a prefix is free text and can contain LIKE
  -- metacharacters (D% would match everything).
  select coalesce(array_agg(v order by v), '{}')
    into taken
    from (
      select case
               when body ~ '^[0-9]+$' then body::int
               else null
             end as v
        from (
          select case
                   when prefix <> '' and left(car_number, length(prefix)) = prefix
                     then substr(car_number, length(prefix) + 1)
                   else car_number
                 end as body
            from drivers
           where company_id = p_company_id
             and car_number is not null
        ) stripped
    ) s
   where v is not null;

  n := start_at;
  while n = any(taken) loop
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function next_car_number(uuid) from public, anon, authenticated;
grant execute on function next_car_number(uuid) to authenticated;

-- ── 6. Guard both columns ───────────────────────────────────────────
-- car_number:    admins edit it freely (it labels a slot that genuinely moves).
-- driver_number: admin correction only — a company arriving from paper records
--                enters the numbers it already uses, and after that this ends
--                up on payout rows and must not be silently rewritable.
--                Dispatchers cannot touch either: both are staff config, and
--                the role split (20260715) puts config with admins.
-- Drivers can never set their own.
create or replace function guard_driver_numbering()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Edge Functions (service_role) and direct DB access (SQL editor / psql,
  -- where there is no JWT so auth.role() is NULL) are always allowed — the
  -- NULL arm is what lets you still fix a driver by hand.
  if auth.role() is null or auth.role() = 'service_role' then
    return new;
  end if;

  if get_my_role() = 'admin' then
    return new;
  end if;

  if new.car_number    is distinct from old.car_number
     or new.driver_number is distinct from old.driver_number then
    raise exception 'Car number and driver number are admin-only';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_driver_numbering on drivers;
create trigger trg_guard_driver_numbering
  before update on drivers
  for each row
  execute function guard_driver_numbering();

-- ── 7. Snapshot the car number onto the ride ────────────────────────
-- See the header: the car number is reassignable, so history has to be frozen
-- at the moment of assignment or a dispute six months out resolves to whoever
-- holds Car 7 today.
alter table rides add column if not exists car_number_at_assignment text;

-- Backfill from the current mapping. This is exact only for rides whose driver
-- still holds the same car — which is every ride today, since no car number has
-- ever been reassigned (none existed until this migration).
update rides r
   set car_number_at_assignment = d.car_number
  from drivers d
 where d.id = r.driver_id
   and r.driver_id is not null
   and d.car_number is not null
   and r.car_number_at_assignment is null;

-- Folded into the EXISTING set_ride_completed_at trigger (trg_ride_completed_at,
-- already BEFORE UPDATE on rides) rather than added as yet another trigger on
-- the same table — same reasoning as the ride_ref pin in 20260774.
--
-- Re-stamps on EVERY driver change, and freezes only at completion. The naive
-- "freeze once set" version pins the FIRST dispatched driver's car onto a ride
-- that dispatch-assign-ride later reassigned — so a dispute about the car that
-- actually showed up would resolve to a car that never did. The car that drove
-- the ride is the last one assigned before it completed.
create or replace function set_ride_completed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.completed_at is not null then
    -- Already completed — freeze every at-completion field regardless of what
    -- else this update touches.
    new.completed_at := old.completed_at;
    new.platform_fee_percent_at_completion := old.platform_fee_percent_at_completion;
    new.car_number_at_assignment := old.car_number_at_assignment;
    return new;
  end if;

  -- Still open: keep the car number tracking whoever is currently assigned.
  if new.driver_id is not null and new.driver_id is distinct from old.driver_id then
    select car_number into new.car_number_at_assignment
      from drivers where id = new.driver_id;
  elsif new.driver_id is null then
    new.car_number_at_assignment := null;
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at := now();
    select platform_fee_percent into new.platform_fee_percent_at_completion
      from companies where id = new.company_id;
  end if;

  return new;
end;
$$;

-- Trigger trg_ride_completed_at already exists and fires the function above —
-- only the body changed.
