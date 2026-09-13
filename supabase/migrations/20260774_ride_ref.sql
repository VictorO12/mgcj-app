-- Human-readable ride reference: a short code a dispatcher can read over the
-- radio and a passenger can quote to support.
--
-- Background: every ride is identified only by its UUID, which is unusable by
-- humans. Four places independently invented their own identifier by
-- truncating that UUID, and one of them is an active bug:
-- send-ride-receipt builds `RCPT-${ride.id.slice(0,8)}` (8 hex chars, ~4.3e9),
-- which by the birthday bound has a ~1% chance of a collision by ~9,300
-- receipts and ~50% by ~77,000 — a month and ~8 months respectively for one
-- company at 300 rides/day. That number is a DETERMINISTIC function of the
-- UUID, so a retry regenerates the same colliding value, and ride_receipts
-- .receipt_number is UNIQUE while the function emails via Resend BEFORE it
-- inserts and swallows the insert error into a console.error. Net effect on
-- collision: the passenger holds a PDF the database has no row for, and the
-- function returns 200 {sent:true}.
--
-- This column is the fix's foundation — receipt_number derives from it.
--
-- Design notes:
--   • Random, not sequential. The ref crosses company boundaries (receipts,
--     Stripe disputes, support calls), so per-company scoping is wrong; and a
--     bigserial would leak total platform volume to any customer who books one
--     test ride.
--   • 6 chars over a 30-char VOWEL-FREE alphabet (Crockford base32 minus A and
--     E; it already excludes I/L/O/U). No vowels means no code can accidentally
--     spell a word — this gets read aloud over dispatch radio. 30^6 = 729M, so
--     at 10M cumulative rides ~1.4% of inserts retry once. That is the entire
--     cost of the scheme.
--   • Frozen after insert, same reasoning as completed_at (20260718) and
--     platform_fee_percent_at_completion (20260719): an identifier that can
--     move is not an identifier.
--
-- RULE: the ref is an IDENTIFIER, never an AUTHENTICATOR. Do not put it in a
-- receipt-lookup URL or any other unauthenticated path — 729M is enumerable.

-- ── 1. Generator ────────────────────────────────────────────────────
-- random() rather than pgcrypto's gen_random_bytes: this value is explicitly
-- not a secret (see RULE above), and avoiding the dependency keeps the
-- function free of any assumption about which schema pgcrypto landed in.
create or replace function gen_ride_ref()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := '0123456789BCDFGHJKMNPQRSTVWXYZ';  -- 30 chars, no vowels
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * 30)::int, 1);
  end loop;
  return result;
end;
$$;

revoke all on function gen_ride_ref() from public, anon, authenticated;

-- ── 2. Column (nullable for now — backfill happens below) ───────────
alter table rides add column if not exists ride_ref text;

-- ── 3. Backfill BEFORE the freeze trigger exists ────────────────────
-- Order is load-bearing. The freeze trigger below pins ride_ref on every
-- UPDATE; installed first, it would silently clobber every value this block
-- writes. Same trap as the platform_fee_percent backfill (20260719).
--
-- A volatile DEFAULT on ADD COLUMN would also fill existing rows, but it
-- cannot retry on collision — hence the explicit loop.
do $$
declare
  r record;
  candidate text;
  attempts int;
begin
  for r in select id from rides where ride_ref is null loop
    attempts := 0;
    loop
      candidate := gen_ride_ref();
      attempts := attempts + 1;
      exit when not exists (select 1 from rides where ride_ref = candidate);
      if attempts >= 20 then
        raise exception 'gen_ride_ref: 20 collisions in a row — the code space is too full, widen to 7 chars';
      end if;
    end loop;
    update rides set ride_ref = candidate where id = r.id;
  end loop;
end $$;

-- ── 4. Uniqueness, then NOT NULL ────────────────────────────────────
create unique index if not exists rides_ride_ref_key on rides (ride_ref);
alter table rides alter column ride_ref set not null;

-- ── 5. Assign on insert ─────────────────────────────────────────────
-- A BEFORE INSERT trigger rather than a column DEFAULT, because only a trigger
-- can loop on collision. The unique index above stays as the final backstop:
-- two concurrent inserts generating the same code in the same instant would
-- slip past the exists() check, but that is 1-in-729M per pair and the index
-- catches it.
create or replace function assign_ride_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempts int := 0;
begin
  if new.ride_ref is not null then
    return new;
  end if;
  loop
    candidate := gen_ride_ref();
    attempts := attempts + 1;
    exit when not exists (select 1 from rides where ride_ref = candidate);
    if attempts >= 20 then
      raise exception 'gen_ride_ref: 20 collisions in a row — the code space is too full, widen to 7 chars';
    end if;
  end loop;
  new.ride_ref := candidate;
  return new;
end;
$$;

drop trigger if exists trg_assign_ride_ref on rides;
create trigger trg_assign_ride_ref
  before insert on rides
  for each row
  execute function assign_ride_ref();

-- ── 6. Freeze ───────────────────────────────────────────────────────
-- Folded into the EXISTING guard_ride_fare_fields trigger rather than added as
-- a second BEFORE UPDATE trigger on rides. That trigger already fires on every
-- ride update — every status transition, every fare write — and a whole extra
-- trigger whose only body is one assignment does not belong in that path. The
-- freeze semantics also read better next to the other freeze semantics.
--
-- The pin sits ABOVE the actor checks, so it is unconditional: not a passenger,
-- not dispatch, not a service-role Edge Function can move a ride's ref. A
-- genuine correction means dropping the trigger for the statement.
--
-- Pins silently (new := old) rather than raising, so no existing caller that
-- happens to round-trip the column starts failing.
CREATE OR REPLACE FUNCTION guard_ride_fare_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The ride reference is frozen for everyone, including service_role.
  NEW.ride_ref := OLD.ride_ref;

  -- Edge Functions (service_role) and direct DB access (SQL editor / psql /
  -- cron, where there is no JWT so auth.role() is NULL) are always allowed.
  -- The NULL arm is what lets you still fix a ride by hand in the SQL editor.
  IF auth.role() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Dispatch admins: allowed (RLS already scopes them to their own company).
  IF get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  -- Everyone else (passengers, drivers): the money columns are read-only.
  IF NEW.fare_estimate      IS DISTINCT FROM OLD.fare_estimate
     OR NEW.pre_discount_fare IS DISTINCT FROM OLD.pre_discount_fare
     OR NEW.discount_amount   IS DISTINCT FROM OLD.discount_amount
     OR NEW.discount_type     IS DISTINCT FROM OLD.discount_type THEN
    RAISE EXCEPTION 'Fare fields are read-only';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger trg_guard_ride_fare_fields already exists and fires the function
-- above — only the body changed.

-- ── 7. Let a receipt row exist before it has been sent ──────────────
-- send-ride-receipt now inserts the row BEFORE calling Resend, so the unique
-- constraint on receipt_number catches a double-firing webhook instead of
-- emailing twice, and a Resend failure leaves a reconcilable row rather than a
-- PDF with no record. That requires sent_at to be nullable: "row exists,
-- sent_at is null" is precisely "we tried and it failed".
-- No-op if it was already nullable.
alter table ride_receipts alter column sent_at drop not null;
