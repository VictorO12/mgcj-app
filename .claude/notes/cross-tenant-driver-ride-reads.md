# A driver can read rides belonging to another company — found 2026-09-11

Found incidentally while capturing RLS baselines for `20260772`. **Not fixed**,
deliberately: that migration preserves semantics exactly so its before/after
row-count equality means something, and a leak fix inside it would destroy the
only safety net it has.

## What was observed

```
admin  (company 309ea691) sees 134 rides
driver (company 309ea691) sees 308 rides
select count(distinct company_id) from rides where driver_id = <driver>  -> 2
```

Same company for both people, yet the driver sees more than twice what the
dispatcher does, spanning two companies.

## Mechanism

```sql
-- policy "rides: driver can select assigned"
USING (auth.uid() = driver_id)
```

No `company_id` predicate. Compare the dispatcher's:

```sql
-- policy "admins can read all rides"
USING (get_my_role() = ANY(ARRAY['admin','dispatcher'])
       AND company_id = get_my_company_id())
```

So ride visibility is tenant-bounded for staff and **not** for drivers. Any ride
row ever stamped with a given `driver_id` stays readable by that account
forever, whatever company the ride belonged to.

## Why it matters more than it looks

The product is sold to taxi companies that compete with each other in the same
towns. A ride row carries pickup and dropoff addresses, fare, passenger id and
timestamps. A driver who worked for company B and now drives for company A keeps
read access to B's ride records — through the app's own anon key plus their
session, with no special access required.

## Before deciding the fix, size it

```sql
-- How many rides, and whose?
select r.company_id, c.name, count(*)
from rides r left join companies c on c.id = r.company_id
where r.driver_id = '60cb21c2-e2b6-4925-a786-7ad676827b0b'
group by 1, 2;

-- Is this one test account or a real pattern?
select d.driver_id, count(distinct r.company_id) as companies, count(*) as rides
from rides r join drivers d on d.id = r.driver_id
group by 1 having count(distinct r.company_id) > 1;
```

If it is only the seeded test driver, this is a data artefact of moving accounts
between companies during development and the policy is still wrong but has never
leaked anything real.

## The fix is not simply adding company_id

Scoping to `company_id = get_my_company_id()` would hide a driver's OWN past
rides the moment they change companies — including rides they may need for an
earnings dispute. The honest question is whether a ride belongs to the company
or to the driver who drove it, and the answer differs for the trail
(`driver_locations`, evidence for the company) and for earnings (the driver's).

Decide that before writing SQL. Tracked under the "true multi-tenancy
hardening" item in the root CLAUDE.md.
