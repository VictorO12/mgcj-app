# Closing the raw-phone read — plan

**Verified live 2026-08-22** (`g3-profiles-phone-exposure-check.sql`). Not a
theory: a driver read `+19023852308` off a passenger's profile through the same
query the app issues, on a ride that **completed 2 months and 2 days ago**.
`shares_ride_with()` live is byte-for-byte the repo version — no status filter,
no timestamp. Symmetric: the passenger read the driver's personal number back.

Shape chosen by Victor: **revoke the column, keep row access.** Row access is
load-bearing for name/avatar in ride history and `DriverProfileSheet`; the phone
number is the only part that needs to disappear.

---

## 0. The prerequisite — ship this ALONE, before anything else

`REVOKE SELECT (phone)` breaks `SELECT *`. Postgres expands the star to every
column and requires the privilege on all of them, so the statement errors with
`permission denied for column phone` rather than silently omitting it. Three
call sites do exactly that, and all three sit in the **auth path**:

- `mgcj-app/src/hooks/AuthContext.tsx:83`
- `mgcj-app/src/hooks/AuthContext.tsx:112`
- `mgcj-dashboard/src/hooks/useAuth.ts:81`

Revoking before these are fixed is not a regression, it is a **total outage** —
nobody can load a profile, so nobody can log into either app. Note also that
PostgREST defaults to `*` when `.select()` is called with no argument, so any
future bare call reintroduces it.

Replace each with an explicit column list. Phase 0 ships and is confirmed live
on real devices before the revoke migration is even written.

## 1. One definer function for the legitimate readers

```sql
create or replace function public.profile_phone(p_profile_id uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare v text;
begin
  -- self, or staff at the company that may see this person
  if p_profile_id = auth.uid() or is_staff() then
    select phone into v from profiles where id = p_profile_id;
    return v;
  end if;
  return null;   -- fail closed, same as ride-contact
end $$;

revoke execute on function public.profile_phone(uuid) from public, anon, authenticated;
grant  execute on function public.profile_phone(uuid) to authenticated;
```

`revoke from public` alone is NOT enough — Supabase default privileges grant
EXECUTE directly to `anon` and `authenticated`, so a definer function stays
callable by an anon client via PostgREST until those two are revoked **by name**.
Verified against this DB during the driver-liveness work; same pattern applies.

The `is_staff()` branch still needs a company scope decision — a dispatcher at
company A should not read company B's passengers. `is_staff()` alone does not
carry that; the existing policy pairs it with `company_id = get_my_company_id()
OR role = 'passenger'`, and that second half is already broad.

## 2. Reroute the legitimate readers

**Self-phone, displayed in 4 places** — `ProfileScreen.tsx:258`,
`DriverEditProfileScreen.tsx:416`, `ProfileMenu.tsx:252`, and
`AddCardScreen.tsx:57` (Stripe billing details). These read `profile.phone` off
the AuthContext object, which after phase 0 no longer carries it. Either fetch
once via the RPC in AuthContext and merge it in, or call per screen. Merging in
AuthContext keeps the `Profile` type honest and is one call per session.

**Dispatch** — the heavy reader, all via the `is_staff()` branch:
`DashboardPage.tsx:4957-4972` (displays *and* copy-buttons both numbers),
`:3420` (strips to digits for a dial link), `:856`, `:4763`, `:1794`,
`SettingsPage.tsx:122` (staff table). Dispatch calling passengers is real work,
not a leak — these get the RPC, not removal.

**`OTPVerifyScreen.tsx:177`** — `.eq("phone", phone)` on the guest-merge lookup.
Column privileges apply to `WHERE`, not just the select list, so this breaks too.
It needs its own definer RPC (`find_guest_profile_by_phone`), and it is the one
that must be written carefully: a function that takes a phone and returns whether
a profile exists is a **phone-number enumeration oracle** if left ungated. The
existing `phone_is_registered()` has the same shape and is worth re-reading
before adding a second one.

## 3. The revoke

```sql
revoke select (phone) on public.profiles from authenticated, anon;
```

Then re-run `g3-profiles-phone-exposure-check.sql` query 5 and expect a
**permission error**, not a null. A null would mean the row was denied for some
other reason and would leave the actual question unanswered.

Also confirm the opposite direction in the same session: dispatch still sees
passenger numbers, and a driver can still see the passenger's **name and avatar**
(that is the whole reason we revoked the column instead of narrowing the policy).

## 4. Only then, the client cleanup

The six `passenger_phone` fetches and five type fields become genuinely dead once
the server refuses the column. Removing them earlier is theatre — the number stays
equally reachable to anyone with the app bundle and a real JWT, and the diff makes
the codebase look fixed while nothing changed.

---

## Not covered by this plan

**Access is still unbounded in time for the rest of the row.** A driver can read
a passenger's name and avatar forever, for every passenger they have ever carried.
That is a smaller exposure than the phone number and a separate decision — it is
what makes ride history work. Named here so it is not mistaken for closed.

**Anonymous guest bookers get the `authenticated` role.** Supabase anonymous
sign-in is a real `auth.users` row with role `authenticated`, so guests land in
the `shares_ride_with` branch like anyone else. The revoke covers them; the
unbounded row access does not.
