# Making the platform province / country / timezone agnostic

Design pass, 2026-09-13. Inventory + plan. **No code written yet** — per the
design-before-build convention, and because two tier-2 gates have business
answers Victor owns.

## Scope assumption (stated, not asked)

"Any province, country, time zone" is read as **operational localization** —
timezone, currency, phone, address, units, tax identity. It is **not** UI string
translation. Full i18n across ~50 screens is a separate project; so is
tax-regime work (`companies.hst_number` is a Canada-shaped column). If that
reading is wrong, this plan grows a third tier rather than changing.

---

## Live schema — verified, not read off migrations

There is **no `CREATE TABLE companies` anywhere in `supabase/migrations/`**, so
the repo could not answer this. Queried live via the vellon-ops service-role
connector. Actual columns:

```
id, name, stripe_account_id, stripe_onboarded, platform_fee_percent, active,
created_at, student_discount_enabled, student_discount_pct, base_fare,
rate_per_km, hst_number, billing_email, billing_address, payout_model, phone
```

**Nothing geographic exists.** No `timezone`, no `country`, no `currency`, no
`locale`, no `distance_unit`. Every one of those is currently a constant in
source. `hst_number` and `billing_address` are the only geography present and
both are Canada-shaped.

---

## The split that matters: display timezone vs semantic timezone

A single grep for `Halifax` mixes two changes with very different risk. They
must not be done in one sweep.

### Cosmetic (safe, mechanical)
- `timeZone: 'America/Halifax'` inside `toLocaleString` — **11 sites**
  (`scheduled-release` ×4, `broadcast-scheduled-ride` ×2, `edit-ride` ×2,
  `reassign-stale-rides`, `dispatch-assign-ride`, `DashboardPage.tsx:1894`)
  plus `scheduled-ride-digest`'s `TZ` constant.
- `en-CA` locale literals — **109 sites**: app 22, edge functions 13,
  dashboard 65, vellon-ops 9.

These only change what a string looks like. Swap for a resolved per-company
locale + tz.

### Semantic — changes which bucket a row lands in
- `20260723_settlement_net_and_daily.sql:70` and
  `20260737_revert_settlement_pipeline_floor.sql:82` —
  `(r.completed_at at time zone 'America/Halifax')::date as day`.
  This decides which **day** a ride's money belongs to.
- `20260623_student_discount.sql:68-70` — academic-year reset boundary.
- The **monthly revenue views** (`20260714`, `20260719`, `20260730`) are
  deliberately `at time zone 'UTC'`, with a comment saying why.

**Do not casually repoint the revenue views at a per-company timezone.** A
mutable `companies.timezone` feeding a historical bucket is exactly the bug
class that `rides.completed_at` and `rides.platform_fee_percent_at_completion`
were created to kill: changing a company's tz today would silently re-attribute
every past month. Two acceptable outcomes, pick consciously:
  a. Leave the monthly views on UTC (defensible, already documented), or
  b. Snapshot the zone per ride (`rides.timezone_at_completion`), frozen by the
     same trigger/transition as `completed_at`.
Never (c): live-join `companies.timezone`.

### False positives — read before editing
- `20260770_shift_auto_end.sql:38` — "a driver two hours into a run to
  **Halifax**". The city.
- `mgcj-dashboard/src/pages/DashboardPage.tsx:1135` — comment, the city.

---

## Tier 1 — multi-province / multi-timezone within Canada

No external unknowns: same `+1`, same CAD, same Stripe country, same Twilio
number. Covers the actual near-term pipeline (the 34-prospect list is
Canada-wide). Shippable without anyone's permission.

1. **Migration: per-company config.** `timezone` (IANA string — **never** a UTC
   offset; offsets don't carry DST), `locale`, `currency`, `country_code`,
   `distance_unit`. All defaulted to today's values so existing behaviour is
   byte-identical on day one. Include the post-Oct-30-2026 GRANT statements.
2. **One resolver per side**, same pattern as `fare.ts` / `presence.ts`:
   `_shared/companyLocale.ts` for edge functions, a hook/context for each
   client. The lookup must not be re-fetched at 20 call sites.
3. **Replace the 11 display-tz sites and the 109 `en-CA` sites** from the
   resolver.
4. **Decide the semantic-tz question above** and apply it to the two `::date`
   settlement views + the student-discount boundary.
5. **Distance stays metric internally.** Google returns metres, `rate_per_km`
   stays the stored unit, miles are a **display-only** transform. Migrating the
   column would put the fare formula's unit in play for no gain.
   - While here: `DriverActiveRideScreen.tsx:1134` hardcodes
     `Math.ceil(4 + (element.distance.value/1000) * 1.8)` — a fourth copy of the
     fare formula that already disagrees with the live company row
     (`base_fare` is **5.0**, not 4). Latent drift of exactly the kind the
     surcharge bug taught; fold into `fare.ts`.
6. **Google Maps `language=` / `region=`** — currently **absent from every
   call** (grepped, zero hits). Driver turn-by-turn comes back in English
   regardless. Cheap to add once a locale exists.

## Tier 2 — multi-country (design only; two external gates)

**Gate A — Stripe Connect cross-border.** `create-connect-account/index.ts:119`
hardcodes `country: 'CA'`, and **6 sites** hardcode `currency: 'cad'`
(`create-payment-intent`, `scheduled-release`, `edit-ride`, `capture-payment`,
`sweep-held-transfers`, `stripe-webhook`). Needs answering from Stripe docs, not
reasoning: can a CA platform account create and settle connected accounts
outside Canada, and what does `transfer_data[destination]` do across regions?
A wrong currency on a **captured** PaymentIntent is the one thing in this whole
plan that cannot be undone. Note `capture-payment` captures the PI's authorized
amount — a currency mismatch there produces a charge and a receipt that agree
with each other and disagree with reality.

**Gate B — Twilio geo-permissions and sender-ID rules.** OTP rides the shared
`mgcj-app` Messaging Service on a single `+1` long code. That does not deliver
everywhere, and some countries reject long-code or alphanumeric sender IDs
outright. Per-country sender provisioning is a compliance task, not a code task.

**Phone normalization is the genuinely unsolved piece**, and it is *not*
cosmetic. The `+1` sites are all **pre-auth** — `SignUpScreen`,
`DriverSignUpScreen`, `PhoneEntryScreen`, dashboard `LoginPage` — so there is no
company context to resolve a country from. Worse,
`LoginPage.tsx:23` / `DashboardPage.tsx:1993`'s
`if (digits.length === 10) return '+1' + digits` is a **normalization
boundary**: it interacts with `auth.users.phone` having no `+`, and with the
`phone_is_registered()` RPC. Getting it wrong splits identities rather than
merely displaying badly. Cheap answer: device region via `expo-localization` as
an **editable** default, libphonenumber for parse/format.

**Places country restriction**: `components=country:ca` at
`AddressPickerModal.tsx:107` and `PassengerHomeScreen.tsx:650`. Related — the
`", Canada"` suffix-stripping at `PassengerHomeScreen.tsx:102-103` becomes a
silent no-op outside Canada; the reminder SMS it protects will regress.

**Tax**: `companies.hst_number` is Canada-only. GST/HST → VAT/sales-tax is a
deliberate deferral, named here so it isn't discovered mid-build.

---

## Constraint that outranks convenience

None of this config may live in `app.config.js`'s `extra`. `extra` is hashed
into **both** platform fingerprints (measured 2026-08-24), so putting a
timezone there makes every future customer a store-build event. It belongs in
the `companies` row, read at runtime. Related and already known: the app
currently has very few `from('companies')` calls and hardcodes branding in 8+
files — same root cause, same fix shape.
