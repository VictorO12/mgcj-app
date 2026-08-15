-- Why did assign-ride only see one driver?
-- Replays every filter in the assign-ride candidate query, per driver, and
-- names the first one each driver fails. Set the ride id below.
with target as (
  select id, company_id, vehicle_class_id, pickup_lat, pickup_lng,
         coalesce(declined_by, '{}') as declined_by,
         coalesce(timed_out_by, '{}') as timed_out_by
  from rides
  where id = 'ec61bebc-0523-43d1-9c59-8c3afa624f7d'   -- <-- the ride from your logs
),
busy as (
  select r.driver_id
  from rides r, target t
  where r.company_id = t.company_id
    and r.status in ('assigned','driver_arriving','in_progress')
    and r.driver_id is not null
)
select
  p.name,
  left(d.id::text, 8)                       as driver,
  d.is_active,
  d.last_seen_at,
  round(extract(epoch from (now() - d.last_seen_at)))  as secs_since_beat,
  (d.current_lat is not null and d.current_lng is not null) as has_location,
  (d.push_token is not null)                as has_push_token,
  d.vehicle_class_id = t.vehicle_class_id   as class_matches,
  case
    when d.company_id is distinct from t.company_id then 'WRONG COMPANY'
    when not d.is_active                            then 'OFFLINE (is_active=false — reaped?)'
    when d.current_lat is null
      or d.current_lng is null                      then 'NO LOCATION (reaper nulls this too)'
    when d.push_token is null                       then 'NO PUSH TOKEN'
    when t.vehicle_class_id is not null
     and d.vehicle_class_id is distinct
         from t.vehicle_class_id                    then 'WRONG VEHICLE CLASS'
    when d.last_seen_at is not null
     and d.last_seen_at < now() - interval '60 seconds'
                                                    then 'STALE HEARTBEAT (phantom filter)'
    when d.id in (select driver_id from busy)       then 'BUSY ON ANOTHER RIDE'
    when d.id = any(t.declined_by)                  then 'DECLINED THIS RIDE'
    when d.id = any(t.timed_out_by)                 then 'TIMED OUT ON THIS RIDE'
    else 'ELIGIBLE'
  end as verdict
from drivers d
join target t on true
left join profiles p on p.id = d.id
where d.company_id = t.company_id
order by verdict, p.name;
