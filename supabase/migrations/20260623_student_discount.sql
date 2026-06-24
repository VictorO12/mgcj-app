-- Student discount feature: institutions catalog, per-company sponsorship,
-- verification state on profiles, one-time email confirmation tokens,
-- and discount tracking columns on rides.
-- Apply via Supabase dashboard SQL editor per project convention.

-- Platform-wide catalog of recognized institutions (maintained by Victor, not dispatch)
create table institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  created_at timestamptz default now()
);
grant select on institutions to authenticated, service_role;

-- Per-company discount config + sponsored institutions
alter table companies add column student_discount_enabled boolean default false;
alter table companies add column student_discount_pct numeric(5,2) default 0;

create table company_sponsored_institutions (
  company_id uuid references companies(id) not null,
  institution_id uuid references institutions(id) not null,
  primary key (company_id, institution_id)
);
grant select, insert, update, delete on company_sponsored_institutions to authenticated, service_role;

-- Verification facts on profiles
alter table profiles add column student_verified boolean default false;
alter table profiles add column student_email text unique;
alter table profiles add column student_institution_id uuid references institutions(id);
alter table profiles add column student_verified_at timestamptz;

-- One-time email confirmation tokens
create table student_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) not null,
  institution_id uuid references institutions(id) not null,
  email text not null,
  token text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz default now()
);
grant select, insert, update on student_verification_tokens to authenticated, service_role;

-- Fare/discount tracking on rides
alter table rides add column discount_type text check (discount_type in (null, 'student'));
alter table rides add column pre_discount_fare numeric(10,2);
alter table rides add column discount_amount numeric(10,2);

-- Single source of truth for "is this passenger's student discount currently valid
-- for this company" — resets every academic year on Sept 1 (America/Halifax).
create or replace function get_student_discount_valid(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from profiles p
    join company_sponsored_institutions csi
      on csi.institution_id = p.student_institution_id
      and csi.company_id = p_company_id
    where p.id = p_user_id
      and p.student_verified
      and p.student_verified_at >= make_date(
        case
          when extract(month from now() at time zone 'America/Halifax') >= 9
          then extract(year from now() at time zone 'America/Halifax')::int
          else extract(year from now() at time zone 'America/Halifax')::int - 1
        end,
        9, 1
      )
  );
$$;

grant execute on function get_student_discount_valid(uuid, uuid) to authenticated, service_role;

-- Computes the discounted fare without requiring the client to read the
-- companies table directly (avoids needing a passenger-facing RLS policy
-- on companies.student_discount_pct).
create or replace function compute_student_discount(p_user_id uuid, p_company_id uuid, p_fare numeric)
returns table(discounted_fare numeric, discount_amount numeric)
language plpgsql
security definer
stable
as $$
declare
  v_enabled boolean;
  v_pct numeric;
  v_amount numeric;
begin
  if not get_student_discount_valid(p_user_id, p_company_id) then
    return query select p_fare, 0::numeric;
    return;
  end if;

  select student_discount_enabled, student_discount_pct
    into v_enabled, v_pct
    from companies
    where id = p_company_id;

  if not coalesce(v_enabled, false) or coalesce(v_pct, 0) <= 0 then
    return query select p_fare, 0::numeric;
    return;
  end if;

  v_amount := round(p_fare * (v_pct / 100), 2);
  return query select round(p_fare - v_amount, 2), v_amount;
end;
$$;

grant execute on function compute_student_discount(uuid, uuid, numeric) to authenticated, service_role;

-- Seed Acadia to start
insert into institutions (name, domain) values ('Acadia University', 'acadiau.ca');
