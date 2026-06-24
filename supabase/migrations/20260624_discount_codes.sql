-- General discount code feature: dispatch-created codes (percent or fixed
-- amount, validity window, optional max redemptions / one-per-passenger),
-- usable by passengers without a valid student discount (student discount
-- always wins and codes are not stackable with it).

create table discount_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) not null,
  code text not null,
  label text,
  amount_type text not null check (amount_type in ('percent', 'fixed')),
  amount numeric(10,2) not null check (amount > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions int,
  one_per_passenger boolean not null default false,
  active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  unique (company_id, code)
);
grant select, insert, update, delete on discount_codes to authenticated, service_role;

alter table rides add column discount_code_id uuid references discount_codes(id);

alter table rides drop constraint if exists rides_discount_type_check;
alter table rides add constraint rides_discount_type_check
  check (discount_type in (null, 'student', 'code'));

-- Single entry point for discount calculation at booking time. Student
-- discount takes priority and is never combined with a code. Returns
-- code_status so the client can show a specific reason when a code can't
-- be applied (not_found / inactive / not_started / expired / maxed /
-- already_used), distinct from 'none' (no code submitted) and 'ok'.
create or replace function compute_discount_for_booking(
  p_user_id uuid,
  p_company_id uuid,
  p_fare numeric,
  p_code text default null
)
returns table(
  discounted_fare numeric,
  discount_amount numeric,
  discount_type text,
  code_id uuid,
  code_status text
)
language plpgsql
security definer
stable
as $$
declare
  v_student_valid boolean;
  v_code_row discount_codes%rowtype;
  v_amount numeric;
  v_redemption_count int;
  v_already_used boolean;
begin
  v_student_valid := get_student_discount_valid(p_user_id, p_company_id);
  if v_student_valid then
    return query
      select d.discounted_fare, d.discount_amount, 'student'::text, null::uuid, 'ok'::text
      from compute_student_discount(p_user_id, p_company_id, p_fare) d;
    return;
  end if;

  if p_code is null or trim(p_code) = '' then
    return query select p_fare, 0::numeric, null::text, null::uuid, 'none'::text;
    return;
  end if;

  select * into v_code_row from discount_codes
    where company_id = p_company_id and code = upper(trim(p_code));

  if v_code_row is null then
    return query select p_fare, 0::numeric, null::text, null::uuid, 'not_found'::text;
    return;
  end if;

  if not v_code_row.active then
    return query select p_fare, 0::numeric, null::text, v_code_row.id, 'inactive'::text;
    return;
  end if;

  if v_code_row.starts_at is not null and now() < v_code_row.starts_at then
    return query select p_fare, 0::numeric, null::text, v_code_row.id, 'not_started'::text;
    return;
  end if;

  if v_code_row.ends_at is not null and now() > v_code_row.ends_at then
    return query select p_fare, 0::numeric, null::text, v_code_row.id, 'expired'::text;
    return;
  end if;

  if v_code_row.max_redemptions is not null then
    select count(*) into v_redemption_count from rides where discount_code_id = v_code_row.id;
    if v_redemption_count >= v_code_row.max_redemptions then
      return query select p_fare, 0::numeric, null::text, v_code_row.id, 'maxed'::text;
      return;
    end if;
  end if;

  if v_code_row.one_per_passenger then
    select exists(
      select 1 from rides
      where discount_code_id = v_code_row.id and passenger_id = p_user_id
    ) into v_already_used;
    if v_already_used then
      return query select p_fare, 0::numeric, null::text, v_code_row.id, 'already_used'::text;
      return;
    end if;
  end if;

  if v_code_row.amount_type = 'percent' then
    v_amount := round(p_fare * (v_code_row.amount / 100), 2);
  else
    v_amount := least(v_code_row.amount, p_fare);
  end if;

  return query select round(p_fare - v_amount, 2), v_amount, 'code'::text, v_code_row.id, 'ok'::text;
end;
$$;

grant execute on function compute_discount_for_booking(uuid, uuid, numeric, text) to authenticated, service_role;
