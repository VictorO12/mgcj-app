# Closing the raw-phone read — plan

**Verified live 2026-08-22** (`g3-profiles-phone-exposure-check.sql`). Not a
theory: a driver read `+19023852308` off a passenger's profile through the same
query the app issues, on a ride that **completed 2 months and 2 days ago**.
`shares_ride_with()` live is byte-for-byte the repo version — no status filter,
no timestamp. Symmetric: the passenger read the driver's personal number back.

Shape chosen by Victor: **revoke the column, keep row access.** Row access is
load-bearing for name/avatar in ride history and `DriverProfileSheet`; the phone
number is the only part that needs to disappear.

**Revised 2026-08-23** after the guest rework (`3e38c88`, `c00c633`, `9ce76a8`)
and a re-read of the grant mechanics. Three changes, all marked ▲ below:
§0 keeps `phone`, §2's OTPVerify item is gone, §3's revoke statement is probably
a no-op as written and has to be rehearsed before it is trusted.

---

## 0. The prerequisite — ship this ALONE, before anything else

`REVOKE SELECT (phone)` breaks `SELECT *`. Postgres expands the star to every
column and requires the privilege on all of them, so the statement errors with
`permission denied for column phone` rather than silently omitting it. Swept
both repos on 2026-08-23 (`select("*")`, bare `.select()`, embedded
`profiles(...)`): exactly three sites, all in the **auth path**, unchanged from
the original list.

- `mgcj-app/src/hooks/AuthContext.tsx:83`
- `mgcj-app/src/hooks/AuthContext.tsx:112`
- `mgcj-dashboard/src/hooks/useAuth.ts:81`

Revoking before these are fixed is not a regression, it is a **total outage** —
nobody can load a profile, so nobody can log into either app. Note also that
PostgREST defaults to `*` when `.select()` is called with no argument, so any
future bare call reintroduces it.

▲ **The explicit list must still include `phone` in this phase.** Dropping it
here blanks the four self-phone displays (§2) the moment phase 0 lands — a
visible regression shipped by itself, from a phase whose whole value is being a
behavioural no-op ("no bare stars anywhere"). `phone` leaves the list in §2, in
the same commit that reroutes those four screens.

Phase 0 ships and is confirmed live on real devices before the revoke migration
is even written.

## 1. One definer function for the legitimate readers

▲ The `is_staff()` scope question is settled: **staff at my company, plus the
passengers my company has actually carried.** A bare `is_staff()` reproduces the
existing policy's `OR role = 'passenger'` hole — any dispatcher at any company
reads any passenger's number. Checked against every dashboard reader before
committing to it (`DashboardPage.tsx:1793` batchProfiles feeds ride lists;
`SettingsPage.tsx:121` is `company_id`-filtered already; `:3420` filters
client-side over numbers batchProfiles already fetched).

```sql
create or replace function public.profile_phone(p_profile_id uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare v text;
begin
  if p_profile_id = auth.uid()
     or (is_staff() and (
           exists (select 1 from profiles p
                    where p.id = p_profile_id
                      and p.company_id = get_my_company_id())
        or exists (select 1 from rides r
                    where r.company_id = get_my_company_id()
                      and (r.passenger_id = p_profile_id
                        or r.driver_id    = p_profile_id))
     ))
  then
    select phone into v from profiles where id = p_profile_id;
    return v;
  end if;
  return null;   -- fail closed, same as ride-contact
end $$;

revoke execute on function public.profile_phone(uuid) from public, anon, authenticated;
grant  execute on function public.profile_phone(uuid) to authenticated;
```

`revoke from public` alone is NOT enough — Supabase default privileges grant
EXECUTE directly to `anon` and `authenticated`, which is a distinct grant that
survives revoking PUBLIC. Bitten by this three times now, most recently in
`20260762` where `ops_revenue` was readable with the app's publishable key.

### 1b. The booking lookup — a second, differently-shaped RPC

`DashboardPage.tsx:2638` and `:5010` do `.eq("phone", phone)` when dispatch
books for a number. Column privileges apply to `WHERE`, not just the select
list, so the revoke breaks both. This is dispatch's *first* contact with a
passenger — no ride exists yet, so §1's ride scope cannot cover it, and it is a
genuinely different question: **phone → who is this**, never **who → what is
their phone**.

`find_passenger_by_phone(p_phone text)` returns `id`, `name` only — never the
number back — and is staff-only. Written carefully, because a function that
takes a phone and says whether a profile exists is a **phone-number enumeration
oracle**. `phone_is_registered()` has the same shape and is worth re-reading
first. Keep the existing role filter semantics (`role.eq.passenger,role.is.null`)
inside the function; the comment at `:2638` explains why NULL must be tolerated.

## 2. Reroute the legitimate readers

**Self-phone, displayed in 4 places** — `ProfileScreen.tsx:258`,
`DriverEditProfileScreen.tsx:416`, `ProfileMenu.tsx:252`, and
`AddCardScreen.tsx:57` (Stripe billing details). These read `profile.phone` off
the AuthContext object. Fetch once via the RPC in AuthContext and merge it in —
one call per session, and it keeps the `Profile` type honest. `phone` comes out
of phase 0's explicit column list in this same commit.

**Dispatch** — the heavy reader: `DashboardPage.tsx:1793` (batchProfiles, which
feeds the display and copy buttons at `:4957-4972` and the search at `:3420`),
`SettingsPage.tsx:121` (staff table). Dispatch calling passengers is real work,
not a leak — these get the RPC, not removal. Batch shape wanted: a set-returning
`profile_phones(uuid[])` rather than N round trips per ride list.

**Driver/passenger raw fetches — delete, do not reroute.** `DriverApp.tsx:596,
720, 818`, `AssignedRidesListScreen.tsx:170, 206, 320`, `useActiveRide.ts:244`
and the `passenger_phone` type fields. G3 Phase 2 already replaced every consumer
with `useRideContact`'s proxy number; these fetches are what feeds nothing.

▲ **`OTPVerifyScreen.tsx:177` is gone** — no RPC needed. `3e38c88` replaced the
guest merge with `claim_guest_rides()`, which takes **no arguments**: caller and
phone both come from the verified JWT. The enumeration-oracle risk flagged here
never has to be built.

## 3. The revoke

▲ **The statement in the first draft is probably a no-op.** Query 3 showed a
*table-level* SELECT grant to `anon` and `authenticated`. A table-wide SELECT
covers every column and a column-level REVOKE does not carve a hole in it —
Postgres emits a warning and access is unchanged. The failure mode is "revoke
ran, no error, still readable": the same false-relief shape as
`cron.job_run_details` reporting SUCCESS while the function 401'd.

**Rehearse before believing either form.** In one transaction: run the revoke,
re-run check query 5(a), `ROLLBACK`. If the phone still comes back, the real
shape is drop-and-re-grant:

```sql
revoke select on public.profiles from authenticated, anon;
grant  select (id, name, role, company_id, avatar_url, /* … enumerate … */)
  on public.profiles to authenticated, anon;
```

Also check for a `PUBLIC` grant in the same pass — check query 3's
`grantee IN (...)` filter excluded the row that would show it, and both roles
inherit PUBLIC. And check live for any **view** over `profiles`: a non-
`security_invoker` view keeps its owner's access and would mask the revoke
entirely. None exists in the migrations, which per the standing lesson is not
evidence about the live DB.

Consequence to accept with the explicit-column form: `profiles` columns become a
maintenance surface. Every new-column migration needs a grant line, the same way
new tables need one post-Oct-2026.

Then re-run query 5 and expect a **permission error**, not a null. A null would
mean the row was denied for some other reason and would leave the actual
question unanswered. Confirm the opposite direction in the same session:
dispatch still sees passenger numbers, and a driver still sees the passenger's
**name and avatar** — that is the whole reason we revoked the column instead of
narrowing the policy.

## 4. Only then, the client cleanup

Removing the raw fetches earlier is theatre — the number stays equally reachable
to anyone with the app bundle and a real JWT, and the diff makes the codebase
look fixed while nothing changed.

---

## Not covered by this plan

**Access is still unbounded in time for the rest of the row.** A driver can read
a passenger's name and avatar forever, for every passenger they have ever
carried. Smaller than the phone number and a separate decision — it is what
makes ride history work. Named so it is not mistaken for closed.

**`phone_is_registered()` remains a phone → exists probe.** Definer, deliberately
unfiltered (it must answer pre-session, for returning drivers as well as
passengers). After the revoke it is the last one standing, so it will look like
an oversight later. Pre-existing, out of scope here.

**Anonymous guest bookers get the `authenticated` role.** Supabase anonymous
sign-in is a real `auth.users` row with role `authenticated`, so guests land in
the `shares_ride_with` branch like anyone else. Since `9ce76a8` dispatch no
longer impersonates them — `create-guest-passenger` mints the row with the
service role — but the guest's own session, once they sign up, is ordinary.
