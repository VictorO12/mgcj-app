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

## APPLIED AND VERIFIED LIVE — 2026-08-23

`20260764` (definer readers) and `20260765` (the revoke) are **applied to the live
DB**, and both clients are shipped: app build cut and on device, dashboard deployed
from `5d268cd`. Dispatch board and both app roles confirmed working by hand after
the revoke — numbers rendering, no blank fields, no errors.

Evidence, so a later session does not have to re-derive it (and does not mistake
these files for proof the SQL ran — see `migration-files-are-not-applied-state`):

| check | result |
|---|---|
| `has_column_privilege` over all 20 columns of `profiles` | exactly 5 false — `phone`, `guest_phone`, `email`, `student_email`, `stripe_customer_id` — and 15 true, matching the GRANT list one-for-one |
| `profile_phone()` — unrelated driver / own-company staff / self | null / number / number |
| `profile_phone`, `profile_phones` via publishable key (curl) | `401` `42501 permission denied for function` |
| `SELECT` on `profiles` via publishable key (curl) | `401` `42501 permission denied for table` |
| `phone_is_registered` via publishable key (curl) | `200` — pre-session signup path intact |

Two things learned in the applying that are not obvious from the migration:

- **The grant list's completeness is a separate check from its correctness.** Verifying
  that `phone` is false and `name` is true proves the intended withholds landed; it does
  not prove no live column was missed when the list was enumerated by hand. A missed
  column does not read empty — the client still requests it and PostgREST fails the
  **whole select** with `42501`. That is a hard dispatch outage, not a blank field, and it
  is a different signature from the `PROFILE_COLUMNS` drift the table comment warns about.
  Run the `pg_attribute` enumeration, not a spot check.
- **Order was push-then-revoke, and it mattered.** The dashboard was 4 commits behind on
  origin, still selecting `phone` in `batchProfiles` and filtering `.eq("phone", ...)` on
  manual booking. Applying the revoke against that deployment would have taken out the ride
  board, driver list, staff table and guest booking — dispatch, not the app. The mobile half
  of the gate is a build on devices; the dashboard half is a deploy, and it is easy to
  count only the first.

Rollback, if it is ever needed: `GRANT SELECT ON public.profiles TO authenticated;`

---

## 0. The prerequisite — ▲ DONE 2026-08-23 (`2f298c5` app, `d88fd8b` dashboard)

Shipped as a behavioural no-op, both repos, dashboard build clean and app
`tsc` error count identical to baseline (337, all pre-existing). Still needs
real-device confirmation before §3 goes anywhere near the DB.

Two further sweeps completed 2026-08-23, both clean — the first grep found
neither, because it started from `from("profiles")`:

- **Embedded selects.** `.from("rides").select("*, passenger:profiles(*)")`
  expands to every column of `profiles` and fails post-revoke exactly like a
  top-level star. Swept table-agnostically (`profiles?\s*\(|profiles!`): two
  hits, `RideHistoryScreen.tsx:293-294`, both requesting `(name)` explicitly.
- **Edge Functions on the caller's JWT.** `service_role` keeps its table grant,
  so anything on the service client is untouched — but three functions read
  `profiles` through the caller's client before switching: `capture-payment:76`,
  `delete-account:33`, `delete-driver:46`. All three select only `role` /
  `company_id`, both of which stay granted. Worth having checked: a payment path
  breaking on the revoke would break quietly, mid-ride, which is worse than a
  login path breaking loudly.

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
    -- coalesce, not `phone`: claim_guest_rides() moves a retiring guest's
    -- number to guest_phone, and dispatch still needs it on that guest's
    -- historic rides. This is the only reader that delivers it.
    select coalesce(phone, guest_phone) into v from profiles where id = p_profile_id;
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

## 2. Reroute the legitimate readers — DONE 2026-08-23 (`28e6a87` app, `5d268cd` dashboard)

**Scope settled 2026-08-23:** the withheld set is `phone`, `guest_phone`,
`email`, `student_email`, `stripe_customer_id` — not `phone` alone. The two
email columns are contact PII of exactly the same class reaching exactly the
same counterparty through the same policy branch, and both are only ever read
about oneself in either repo (`ProfileScreen.tsx:34`, `DiscountsScreen.tsx:229`),
so they join the self-bundle at no extra round trip. `stripe_customer_id` has
zero client readers and is free.

**▲ `push_token` should probably join them — new information, 2026-08-23.**
It was kept out because `useNotifications.ts:172` self-reads it. But
`_shared/push.ts:120` sends to Expo with **no `Authorization` header**, so this
project does not have Expo's Enhanced Security for Push Notifications enabled:
possession of an `ExponentPushToken` is sufficient to push anything to that
device. Keeping the column granted therefore means a driver can read a
passenger's token through `shares_ride_with` and send them "Your ride has been
cancelled" from a stranger — and the passenger can do the same back.

The cost of withholding turns out to be near zero: that self-read is a pure
optimisation to skip a redundant write, and the same function already keeps the
token in `AsyncStorage` under `LAST_TOKEN_KEY` and compares against it at
`:40`. Drop the DB read, or add `push_token` to the self bundle phase 2 is
building anyway. Verify the Expo project setting before acting — the absent
header is strong evidence, not proof.

**▲ The realtime subscription will fight the merge.** `AuthContext` subscribes to
`postgres_changes` on the user's own `profiles` row and does
`setProfile(payload.new as Profile)`. Realtime's WAL filter applies **column
grants** for the subscribed role, so after the revoke `payload.new` arrives
without the five withheld columns — and that raw assignment clobbers whatever
the RPC merged in, blanking the user's own phone/email a moment after any
unrelated profile write. Merge the payload over the existing state, keeping the
private fields, rather than replacing.


**▲ The private bundle must be fetched inside `fetchProfile`, not merged in
beside it.** `fetchProfile` and `refetch` both do a straight `setProfile(data)`
— the same replace-clobbers-merge bug just fixed in the realtime handler, one
door over. `refetch()` is called from the OTP path and from `DiscountsScreen`'s
subscription, so a bundle merged in anywhere else is dropped the next time
either fires. One function constructs a complete profile; everything else calls
it. This changes the shape of the phase 2 edit rather than adding to it.

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

## 2b. ▲ The revoke is a hard break for every app build that predates phase 2

Phase 0 did not make old builds safe — it made them *fail differently*. Its
`PROFILE_COLUMNS` NAMES `phone, email, student_email, stripe_customer_id,
guest_phone`, so once `20260765` lands, an installed build asking for those
columns gets `permission denied for column phone` in `fetchProfile`, on the auth
path, exactly as the star would have. The dashboard is fine — Vercel serves one
version — but the mobile rollout is not atomic and old builds linger, the same
constraint that made `last_seen_at IS NULL` mean "live" with no backfill.

So the phase 2 build is the **forward-compatible** one: its `PROFILE_COLUMNS`
must name none of the withheld columns, and the values must come from
`my_private_profile()`. The gate on `20260765` is therefore **adoption of that
build**, not "it works on my device" — a device test proves the new build is
fine and says nothing about the old ones still installed.

Cheap right now, and worth applying while it is: there are no live customers, so
the installed population is Victor's devices and the demo phones. Post-launch
this same step needs a min-version gate or an EAS-update adoption check. Do not
carry this plan forward to a later revoke without re-reading this section.

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

Writes are unaffected by the read revoke. Every `profiles` write in either repo
was checked for a chained `.select()`, since RETURNING needs SELECT on the
columns it returns: the two `OTPVerifyScreen` upserts (:151, :227),
`ProfileScreen.tsx:137` (which writes `email`) and
`DriverEditProfileScreen.tsx:305` are all bare updates with no RETURNING;
`SettingsPage.tsx:179` and `DashboardPage.tsx:3160/3165` do return rows but name
only non-withheld columns. Checked, not assumed.

**Verify the realtime subscription still fires AT ALL, immediately after
applying.** §2's note assumes the WAL filter narrows the payload's columns. The
worse possibility is that WALRUS's visibility check wants table-level SELECT,
finds none, and drops the change entirely — the subscription goes silent rather
than arriving short, and `AuthContext` stops seeing its own profile updates.
There is a natural canary: `DiscountsScreen`'s student-verification flow does
nothing until that subscription delivers `student_verified`. Run it end to end
right after the revoke. This also answers open question #1 empirically, which
reading `realtime.apply_rls` only answers by inference.

Then re-run check query 5 and expect a **permission error**, not a null. A null
would mean the row was denied for some other reason and would leave the actual
question unanswered. Confirm the opposite direction in the same session:
dispatch still sees passenger numbers through the RPC, and a driver still sees
the passenger's **name and avatar** — that is the whole reason we revoked the
column instead of narrowing the policy.

## 4. ~~Only then, the client cleanup~~ — WRONG, and done in phase 2 instead

The claim was that removing the seven counterparty-phone fetches before the
revoke is theatre. That is true of their SECURITY value — the number stays
reachable to anyone with the bundle and a real JWT until the server refuses it —
and it is the wrong conclusion, because those fetches **name `phone`
explicitly**. Post-revoke they do not go stale, they ERROR: on
`showRideRequestPopup` (the ride-offer popup), on `AssignedRidesListScreen` (the
driver ride list) and in `useActiveRide` (passenger live tracking). Not optional
cleanup — breakage. Removed in `28e6a87`.

They fed nothing: G3 Phase 2 replaced every consumer with `useRideContact`'s
masked line, and a grep for real reads turned up only comments describing that
removal. The type fields went with them.

---

## Open before §1 is applied — worked 2026-08-23, ALL CLOSED

**1. Realtime column filtering — ANSWERED 2026-08-23. Not a bypass.**

`realtime.apply_rls` calls `pg_catalog.has_column_privilege(working_role, entity_,
c.name, 'SELECT')` in three places: computing `is_selectable` for `columns`, again for
`old_columns`, and when building the payload's `columns` metadata. Both the `record` and
`old_record` aggregations then filter on `is_selectable`. `working_role` is
`subs.claims_role` — the role off the subscriber's JWT — so the withheld columns are
stripped from the WAL payload per subscriber, before it leaves Postgres.

`pg_publication_rel.prattrs` for `profiles` in `supabase_realtime` is **null**: no
publication-level column list, which is a separate mechanism from grants and would have
filtered regardless. So the answer rested entirely on `apply_rls`, and `apply_rls`
honours the grant.

Two consequences:

- **The merge fix is load-bearing, not defensive.** Payloads on `profiles` now genuinely
  DO arrive short of the private columns — that is designed behaviour, not a maybe. Had
  the auth hooks still been replacing the profile on `payload.new`, the first realtime
  update to one's own row after the revoke would have blanked phone and email in-app.
  `df8e971` / `f3f4aae` fixed a certainty, not a risk. Do not revert them to a replace.
- **A withheld primary key would hard-fail.** `apply_rls` returns `Error 401:
  Unauthorized` for a role with no SELECT on the pkey. `id` is granted to `authenticated`,
  so this is fine — but `anon` now has SELECT on NOTHING in `profiles`, `id` included, so
  any anon subscription to that table takes the 401 path. Nothing subscribes anonymously
  today. Tripwire for later.

Blast radius, checked while answering: the `rides` subscriptions never carried profile
data — `postgres_changes` payloads are single rows, no joins — so there is nothing to
re-examine there. `DiscountsScreen.tsx:102` reads only `student_verified`, which stays
granted, and calls `refetch()` anyway.

**2. `profile_phone()` denial cases — DONE 2026-08-23, all ran, all passed.** Added as
section 9 of `g3-profiles-phone-exposure-check.sql`: driver→carried passenger
must be null, staff-at-another-company must be null, own-company dispatch must
get the number, self must get own, a retired guest must resolve through
`guest_phone`, and anon must get 42501 **via curl with the publishable key** —
`SET ROLE anon` in a superuser session does not reproduce a PostgREST request.
Every wrong parenthesisation of that function fails OPEN, which is why the
denials are tested and not just the grants.

**3. Retired guest minting a duplicate — CLEAR, checked in code.**
`create-guest-passenger`'s `findPassenger()` matches on `phone`, and
`claim_guest_rides()` sets the retiring guest's `phone` to NULL (moving it to
`guest_phone`). So the retired row is invisible to the lookup by construction
and the number resolves only to the real profile; no third row can be minted.
`profiles_phone_key` permits many NULLs, so retired guests never collide with
each other either. `find_passenger_by_phone()` must mirror this exactly — match
`phone` only, never `guest_phone` — and the reason is now a real dependency, not
a preference.

**4. The hand-maintained grant list — DONE, the `COMMENT ON TABLE` shipped in `20260765`.** Both repos' `PROFILE_COLUMNS` plus the
migration: three edits per new column, or it silently reads empty. Ship a
`COMMENT ON TABLE public.profiles` in the revoke migration saying exactly that,
naming both file paths.

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
