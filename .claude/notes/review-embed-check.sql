-- Is rides -> ride_reviews a to-ONE embed? PostgREST decides by whether
-- ride_id carries a UNIQUE constraint on its own. If it does, the embed
-- comes back as an object and `ride_reviews[0]` is undefined.
select conname,
       contype,                       -- 'u' = unique, 'p' = primary, 'f' = fk
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.ride_reviews'::regclass
order by contype;

-- Same question from the index side (a UNIQUE INDEX counts too).
select indexname, indexdef
from pg_indexes
where tablename = 'ride_reviews' and schemaname = 'public';
