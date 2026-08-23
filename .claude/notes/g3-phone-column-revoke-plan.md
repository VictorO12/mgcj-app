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
§0 keeps `phone`, §2's OTPVerify item is gone, and §3's revoke statement was rehearsed
live and proved to be a no-op — the real form is drop-and-re-grant.

---

## 0. The prerequisite — ▲ DONE 2026-08-23 (`2f298c5` app, `d88fd8b` dashboard)

Shipped as a behavioural no-op, both repos, dashboard build clean and app
`tsc` error count identical to baseline (337, all pre-existing). Still needs
real-device confirmation before §3 goes anywhere near the DB.

One trap found while doing it: `PROFILE_COLUMNS` has to be a single string
**literal**. supabase-js infers the row type from the literal type of the select
string, so an array `.join()` — and a `+` concatenation — widens it to `string`
and degrades every field to `GenericStringError`. The comment in both files says
so; do not "tidy" it into a list.

### Why it had to go first

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

**Scope settled 2026-08-23:** the withheld set is `phone`, `guest_phone`,
`email`, `student_email`, `stripe_customer_id` — not `phone` alone. The two
email columns are contact PII of exactly the same class reaching exactly the
same counterparty through the same policy branch, and both are only ever read
about oneself in either repo (`ProfileScreen.tsx:34`, `DiscountsScreen.tsx:229`),
so they join the self-bundle at no extra round trip. `stripe_customer_id` has
zero client readers and is free. `push_token` stays granted: `useNotifications.ts:172`
does a real self-read of it to skip a redundant write, and that path is
load-bearing for dispatch.

**▲ The realtime subscription will fight the merge.** `AuthContext` subscribes to
`postgres_changes` on the user's own `profiles` row and does
`setProfile(payload.new as Profile)`. Realtime's WAL filter applies **column
grants** for the subscribed role, so after the revoke `payload.new` arrives
without the five withheld columns — and that raw assignment clobbers whatever
the RPC merged in, blanking the user's own phone/email a moment after any
unrelated profile write. Merge the payload over the existing state, keeping the
private fields, rather than replacing.


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

**Rehearsed live 2026-08-23 — `REVOKE SELECT (phone)` does nothing.** Run inside
a transaction against a real driver JWT, the passenger's `+19023852308` still
came back. Postgres warned rather than erroring: query 3's *table-level* SELECT
grant to `anon`/`authenticated` covers every column, and a column-level revoke
cannot carve a hole in it. Had this shipped as written it would have read as a
clean apply, closed the ticket, and changed nothing — the same shape as
`cron.job_run_details` reporting SUCCESS while the function 401'd.

The real form is drop the table grant and re-grant an explicit column list.
Live column list captured 2026-08-23:

```sql
revoke select on public.profiles from anon;            -- no re-grant: see below
revoke select on public.profiles from authenticated;
grant  select (
  id, name, role, created_at, push_token, avatar_url, stripe_customer_id,
  email, company_id, student_verified, student_email, student_institution_id,
  student_verified_at, is_active, deactivation_pending, deleted_at,
  notification_prefs, is_guest
) on public.profiles to authenticated;
```

### ▲ `guest_phone` must be withheld too — it is the same number

`20260758` added `profiles.guest_phone`: when a guest signs up for real,
`claim_guest_rides()` moves the number off `phone` onto `guest_phone` so the
retired shell row stops colliding with the new profile "while staying visible to
dispatch on historic rides". It holds a **real phone number**. Granting it while
revoking `phone` reopens the exposure through the new column — a driver who
carried that guest reads their number via the same `shares_ride_with` branch,
and the migration would look like it had closed the leak.

Nothing reads `guest_phone` in either client today (grepped both repos: zero
hits), so withholding it breaks nothing. `profile_phone()` should return
`coalesce(phone, guest_phone)` — that actually *delivers* the dispatch
visibility the column was added for, which no code currently provides.
`find_passenger_by_phone()` must NOT match against it: a retired guest never
matching a dispatch lookup again is the whole point of the move.

`anon` gets nothing back. Every policy on `profiles` is `TO authenticated`, so
RLS already denies anon every row; the grant is dead weight that only widens the
blast radius of a future policy written without a role clause. Guest bookers are
`authenticated` (anonymous sign-in is a real user), and the pre-session flows
(`phone_is_registered`) are definer RPCs, not table reads — so nothing anon-side
reads this table today.

**The column list came from the live DB**, not from the migrations — a column
present live but missing from the grant is a silently-empty field, not an error.
Re-enumerate before applying in case anything landed in between, and keep the
list in the migration body so the next person can diff it.

Consequence to accept: `profiles` columns become a maintenance surface. Every
new-column migration needs a grant line, the same way new tables have needed one
since Oct 2026. Worth a comment on the table itself saying so.

Also settle in the same pass:
- ~~**A `PUBLIC` grant**~~ — checked 2026-08-23, `relacl` is
  `{postgres,anon,authenticated,service_role}` with no PUBLIC entry. Clear.
- ~~**Any view over `profiles`**~~ — checked live, no view or matview references
  the table. Clear.
- **Three `{public}`-role policies on `profiles`** (`Anonymous users can insert
  their own profile`, `profiles: insert own`, `profiles: update own`) — all
  INSERT/UPDATE, so none of them keeps a read alive after the SELECT revoke. But
  the first is very likely dead since `9ce76a8` moved guest creation to the
  service role, and `{public}` is the role clause you do not want on a policy
  someone later widens to SELECT. Separate cleanup, named here so it is on the
  record.
- **`UPDATE (phone)` is untouched and stays that way.** RLS confines a client to
  its own row, and `OTPVerifyScreen`'s upsert writes `phone` on every sign-in —
  revoking the write would break signup. Named because "revoked the phone column"
  will later sound like it covered both directions.

Writes are unaffected by the read revoke: the two `profiles` upserts in
`OTPVerifyScreen` (:151, :227) do not `.select()` back, so there is no RETURNING
clause needing SELECT on the columns they write. Checked, not assumed.

Then re-run check query 5 and expect a **permission error**, not a null. A null
would mean the row was denied for some other reason and would leave the actual
question unanswered. Confirm the opposite direction in the same session:
dispatch still sees passenger numbers through the RPC, and a driver still sees
the passenger's **name and avatar** — that is the whole reason we revoked the
column instead of narrowing the policy.

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
