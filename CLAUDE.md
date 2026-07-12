# CLAUDE.md — mgcj-app

This is the React Native / Expo mobile app repo for the M&G C&J taxi dispatch platform. It serves three user roles from one codebase: passenger, driver, and (in some flows) dispatch.

**For shared project context** (architecture principles, revenue model, Supabase schema conventions, cross-repo technical learnings), see the root-level `CLAUDE.md` at `/home/victor/Documents/projects/CLAUDE.md`. This file only covers what's specific to this repo.

---

## Repo-Specific Stack Details

- Expo account: `victor121222`
- EAS project ID: `1df2c110-8290-4853-9574-2fe4b71799b0`
- Bundle ID: `com.mgcj.app`
- Build profiles: see `eas.json` for current profile definitions (development/preview/production).

---

## App Structure

```
src/
├── screens/
│   ├── auth/        # Welcome, SignUp/PhoneEntry, DriverWelcome/DriverSignUp, OTPVerify
│   ├── passenger/    # PassengerHomeScreen + everything it opens as overlays
│   ├── driver/       # DriverApp + everything it switches to
│   └── shared/       # RideHistoryScreen, HelpSupportScreen (driver copy)
├── components/       # Modals/sheets shared across passenger & driver screens
├── hooks/            # AuthContext, useActiveRide, useDriverRating, useNotifications
├── lib/              # supabase client, decodePolyline
├── types/            # Profile, RootStackParamList
└── navigation/        # empty — see below
```

### Role-based entry points

Role branching happens in `App.tsx`'s `RootNavigator`: `useAuth()` exposes `{ session, profile, loading }`. If there's no `session`, the unauthenticated stack renders (`Welcome` → `SignUp`/`PhoneEntry`/`DriverWelcome`/`DriverSignUp` → `OTPVerify`). Once authenticated, `profile?.role === 'driver'` renders `DriverApp`; everything else (passenger, and currently `admin` too — there's no dedicated admin mobile screen) renders `PassengerHomeScreen`. There is no in-app dispatch/admin role screen on mobile; dispatch work happens in the separate `mgcj-dashboard` repo.

### Navigation — `src/navigation/` is empty and unused, not legacy

There is no router living in `src/navigation/`. Navigation happens two ways:
1. **React Navigation native-stack** (`App.tsx`) for the small set of pre-auth screens (`Welcome`, `PhoneEntry`, `SignUp`, `DriverWelcome`, `DriverSignUp`, `OTPVerify`) plus the two post-auth root screens (`PassengerHome`, `DriverHome`). `RootStackParamList` in `src/types/index.ts` defines this.
2. **Manual state-based screen switching** for everything inside the driver and passenger "apps" — this is the dominant pattern, same as `mgcj-dashboard`. `DriverApp.tsx` holds booleans/state (`showAssigned`, `activeRide`, `showAssignedList`, `pendingRide`) and conditionally returns `DriverSetupScreen` / `AssignedRideScreen` / `DriverActiveRideScreen` / `AssignedRidesListScreen` / `DriverHomeScreen`. `PassengerHomeScreen.tsx` does the same with its own boolean flags (`historyVisible`, `profileVisible`, `notificationsVisible`, `helpVisible`, `scheduledVisible`, `paymentVisible`, `driverProfileVisible`) rendering sibling screens as absolutely-positioned full-screen overlays (`<View style={StyleSheet.absoluteFill}>`) rather than via the navigator.

### Key screens

**Auth (`src/screens/auth/`)**
- `WelcomeScreen` — landing screen with passenger signup / login / "I'm a driver" entry points.
- `SignUpScreen` / `PhoneEntryScreen` — passenger name+phone signup and returning-passenger phone login; both send an OTP via `supabase.auth.signInWithOtp` and hand off to `OTPVerifyScreen`. `PhoneEntryScreen` pre-checks registration via the `phone_is_registered()` RPC (security-definer, works pre-session) before sending the code.
- `DriverWelcomeScreen` / `DriverSignUpScreen` — driver-specific onboarding; registration requires a valid, unused `driver_invites` code (validated before the OTP is even sent).
- `OTPVerifyScreen` — verifies the 6-digit SMS code, then branches: driver path re-validates the invite code, upserts `profiles`+`drivers`, marks the invite used; passenger path checks for a pre-existing **guest profile** (created by dispatch when booking on behalf of an unregistered passenger) keyed by phone number and merges it onto the newly-verified auth user id (including reassigning that passenger's `rides` rows), otherwise upserts a fresh passenger profile.

**Driver (`src/screens/driver/`)**
- `DriverApp` — the driver-side state machine/router described above; owns all ride-fetching, the realtime `rides` subscription, decline/timeout-driven reassignment via `assign-ride`, and notification-tap handling.
- `DriverHomeScreen` — map + online/offline toggle (writes `current_lat/lng` to `drivers` every 10s while online), shows the assigned-ride banner and a horizontally-paged "upcoming scheduled" card panel.
- `DriverActiveRideScreen` — in-ride turn-by-turn screen: polls Google Directions every 30s for ETA/route, advances steps by proximity, detects off-route (>50m from polyline) and auto-reroutes, supports a "nav mode" tilted-camera view, and on completion either calls `capture-payment` (card rides) or opens a cash fare-entry modal.
- `AssignedRideScreen` — full-screen accept/decline view for a single dispatcher-assigned ride (immediate or scheduled); accepting a scheduled ride only sets `confirmed_by_driver`, not `status`.
- `AssignedRidesListScreen` — list of all rides assigned to the driver (immediate + scheduled), with per-card accept/decline and a 10-minute grace window so just-passed scheduled rides don't vanish from sight.
- `RideRequestSheet` — the bottom-sheet ride-offer popup with a 30s countdown timer (auto-declines as a "timeout" rather than a hard decline when it expires); uses a ref for the decline callback to dodge stale-closure bugs.
- `DriverSetupScreen` — one-time vehicle (make/model/year/plate) onboarding gate shown before `DriverHomeScreen` if vehicle fields are unset.
- `DriverEditProfileScreen` — edit name/avatar/vehicle details post-onboarding; avatar upload goes to the `profile-pictures` Supabase Storage bucket.
- `useDriverRating.ts` (in this folder) — **dead code**, see Known Local Issues below.

**Passenger (`src/screens/passenger/`)**
- `PassengerHomeScreen` — the passenger state machine/router: map + address search/autocomplete (Google Places), fare estimation (Directions API distance × flat rate), booking confirmation sheet with a custom inline calendar/time-slot picker for scheduling, card-vs-cash payment selection, and live ride tracking via `useActiveRide`.
- `ScheduledRidesScreen` — list of the passenger's upcoming scheduled rides with cancel action; shows "Finding a driver" for unclaimed `scheduled` rows.
- `PaymentMethodsScreen` — lists saved cards (always shows a non-deletable "Cash" option), set-default/delete actions, links into `AddCardScreen`.
- `AddCardScreen` — Stripe `CardField` collection → `createPaymentMethod` → posts the resulting `pm_...` token to the `save-card` Edge Function.
- `ProfileScreen` — name/avatar/email editing (email is used for receipts) and account deletion (calls `delete-account` Edge Function, then signs out). Note: reads `profile.email`, but `Profile` in `src/types/index.ts` doesn't declare an `email` field — likely a stale type.
- `NotificationsScreen` — notification preference toggles; currently **local-only UI state**, not persisted anywhere (the "Save" button just shows an alert and closes).
- `HelpSupportScreen` (passenger-specific copy) — FAQ accordion + call/email support links.

**Shared (`src/screens/shared/`)**
- `RideHistoryScreen` — used by both roles; lists past rides (role-scoped query), shows/collects driver ratings, and opens `DriverProfileSheet` for passengers. Has a realtime subscription so drivers see new ratings arrive live.
- `HelpSupportScreen` (driver-specific copy, separate from the passenger one of the same name) — driver-oriented FAQ + dispatch contact.

**Components (`src/components/`)**
- `DriverProfileSheet` — bottom sheet showing a driver's avatar/vehicle, aggregate rating breakdown (per-star bar chart), and recent review comments; also surfaces the report-driver entry point and tracks whether the current passenger already reported this ride.
- `ProfileMenu` — the slide-up account menu opened from the avatar button; renders a different item set for driver vs. passenger roles.
- `ReportDriverModal` — passenger-side driver report form (reason codes + optional/required comment); inserts into `driver_reports`, uniqueness enforced by DB constraint (`23505` handled explicitly).
- `RideReviewModal` — passenger-side 1–5 star rating + comment, inserted into `ride_reviews` after ride completion.
- `RideTrackingSheet` — collapsible drag sheet shown to the passenger during an active ride; mini bar vs. expanded view, driver contact actions, cancel logic gated by ride status, and the report-driver entry point.

### Key hooks / context

- `AuthContext` (`useAuth`) — wraps `supabase.auth` session + `profiles` row fetch. Guards against the documented double-fetch-on-mount issue with `fetchingForRef`, and retries the profile fetch (up to 10x, 600ms apart) to ride out trigger/upsert lag right after signup.
- `useActiveRide` — passenger-side hook: fetches/subscribes to the passenger's current active ride (`pending`/`assigned`/`driver_arriving`/`in_progress`), enriches it with driver+profile data, recalculates ETA via Directions API every 30s, and briefly preserves a `completed` ride in state after the row clears so the review modal has time to trigger.
- `useDriverRating` (`src/hooks/`) — the **live** version: fetches a driver's average rating/count from `ride_reviews` and subscribes to realtime `INSERT`s so the average updates without a refetch. The `src/screens/driver/useDriverRating.ts` copy is dead (see below).
- `useNotifications` — registers for Expo push notifications, sets up the driver-only `RIDE_REQUEST` notification category (Accept/Decline action buttons), and writes the resulting token to `drivers.push_token` (drivers) and `profiles.push_token` (everyone).

---

## Local Conventions

- Dark theme color palette is hardcoded per-screen (`#111827` background, `#E8500A` passenger/brand orange, `#1D9E75` driver/online green, `#A855F7` purple for anything scheduled-ride-related) — no centralized theme file yet.
- Polyline decoding is duplicated three times (`src/lib/decodePolyline.ts`, inline in `DriverActiveRideScreen.tsx`, inline in `PassengerHomeScreen.tsx`) rather than imported from the shared lib — all three implementations are identical.

---

## Known Local Issues / WIP

- **`useDriverRating` duplication**: `src/hooks/useDriverRating.ts` and `src/screens/driver/useDriverRating.ts` are accidental duplicates from the same commit. Only the `src/hooks/` version is imported anywhere in the app; the `src/screens/driver/` copy is dead code and is also missing the realtime subscription the live version has. Already confirmed in a prior session — no need to re-investigate, just safe to delete the `src/screens/driver/` copy when convenient.
- `ProfileScreen.tsx` reads `profile.email`, but `Profile` in `src/types/index.ts` has no `email` field — the type is stale relative to the `profiles` table.
- **`scheduled-lifecycle` itself is now dead**, superseded by `scheduled-release` + `scheduled-coverage-monitor` (2026-07-06 rearchitecture, cutover confirmed done 2026-07-11 — `cron.unschedule('scheduled-lifecycle')` has been run). Along with the functions it had already superseded (`schedule-rides`, `scheduled-ride-reminders`, and `notify-drivers/index.ts` — explicitly marked `// Deprecated — replaced by assign-ride`, returns a no-op), all four are safe to delete from the repo.
- `scheduled-ride-reminders/index.ts` reads `profiles.expo_push_token`, but everywhere else in the codebase (mobile + other functions) the column is `push_token` — one more signal it was dead before it was formally retired.
- `DriverApp.tsx`'s notification-tap handler for `data.type === 'scheduled_offer'` (around line 311, triggers `claimScheduledRide`) is now unreachable client-side dead code — only the retired `scheduled-lifecycle` ever sent that push type. Harmless (the "Available" tab still works via a direct pull query in `fetchOpenRides`, independent of push), but safe to remove alongside the edge function cleanup above.

---

## Supabase Edge Functions (`supabase/functions/`)

- **`assign-ride`** — Core auto-dispatch: on a new `pending` ride (or an explicit decline/timeout callback), filters to online+free drivers, Haversine-prefilters to the closest 5, picks the true-fastest by Google Distance Matrix, and assigns with an optimistic-lock update (`.eq('status','pending')`) to avoid double-assignment races. Implements the two-pass decline/timeout cycling described in the root CLAUDE.md. Notifies dispatch if no drivers are available at any point.
- **`broadcast-scheduled-ride`** — Repurposed (2026-07-06) from a driver-facing "ride available" broadcast into a booking-time coverage check. Fires on INSERT of a new `scheduled` ride: computes `coverage_status` (`uncovered`/`at_risk`/`covered`) from the company's driver roster and stamps it on the ride; if `uncovered`, pushes every company admin immediately (so dispatch finds out days out, not at T-60); if `preferred_driver_id` is set, sends that driver a non-binding heads-up push. No longer solicits drivers to claim — that path was removed; advance driver-facing claiming now happens only via the pull-based "Available" list (`fetchOpenRides` in `AssignedRidesListScreen`).
- **`capture-payment`** — Driver-triggered (on ride completion) Stripe PaymentIntent capture for card rides; recalculates the platform fee/transfer split from the company's `platform_fee_percent` and only sets `transfer_data[amount]` if the company has a `stripe_account_id` (Connect-onboarded).
- **`create-payment-intent`** — Passenger-triggered, called at booking time for card rides; creates a manual-capture (hold-only) Stripe PaymentIntent against the passenger's saved default card, with friendly decline-reason mapping.
- **`delete-account`** — Passenger-only self-service account deletion: nulls `passenger_id` on their `rides`/`ride_reviews` (keeps records, detaches them), deletes the `profiles` row, then deletes the Supabase Auth user.
- **`expire-pending-rides`** — Cron: cancels `pending` immediate rides older than 5 minutes (notifies the passenger), and for rides pending 2–5 minutes, clears `declined_by` and re-triggers `assign-ride` to give all drivers another shot.
- **`notify-drivers`** — **Deprecated**, replaced by `assign-ride`; current implementation is just a no-op stub.
- **`notify-passenger`** — Fires on ride UPDATE; pushes the appropriate passenger notification per status transition (assigned-and-confirmed, arriving, in-progress, completed-with-fare, cancelled). Explicitly skips notifying on `assigned` until `confirmed_by_driver` flips true, so passengers aren't told "driver on the way" before the driver has actually accepted.
- **`notify-review`** — Fires on `ride_reviews` INSERT; pushes a star-rating notification (with running average) to the rated driver.
- **`reassign-stale-rides`** — Cron: finds immediate rides `assigned` but unconfirmed by the driver for >60s, and calls `assign-ride` with `timed_out_driver_id` so that driver becomes eligible again on a second cycling pass instead of being permanently excluded.
- **`save-card`** — Passenger-triggered; gets-or-creates a Stripe Customer for the passenger, attaches the submitted PaymentMethod, fetches its display details, and stores it in `payment_methods` (first card saved becomes the default automatically).
- **`scheduled-release`** *(current, cron `*/2 * * * *`)* — Per-ride dynamic release: fetches `scheduled` rides with `scheduled_at` within 75 min, computes a release threshold from drive-time to the 3rd-nearest available driver (or the preferred driver, if set) plus an 8-min churn buffer, clamped 10–75 min. Once inside that threshold, flips the ride to `pending` + invokes `assign-ride` (pool) or `offered` with `driver_id` set directly (preferred driver, stamping `leave_by`/`pickup_eta_mins`). If zero drivers are available it holds and rechecks every tick, force-releasing anyway once inside the 10-min floor so `assign-ride`'s no-drivers alert fires and dispatch can intervene manually. Also sends passenger T-30/T-15 push+SMS reminders (`notified_30min`/`notified_15min`), driver departure-time pushes once `leave_by` arrives (`departure_notified`), and lazily creates the deferred Stripe PaymentIntent for card rides just before release.
- **`scheduled-coverage-monitor`** *(current, cron `*/10 * * * *`)* — Read-only-in-intent: recomputes `coverage_status` for every open scheduled ride and writes it if changed. Sends no push itself — degradation surfaces via Realtime on the dashboard (rollup coverage bar + toast) rather than a notification.
- **`send-ride-receipt`** — Fires on ride UPDATE transitioning to `completed`; emails an HTML receipt via Resend to the passenger's profile email, if one is set (currently sends from Resend's shared test domain — only deliverable to the developer's own verified address until a custom domain is verified).
- **`send-sms`** — Internal-only helper (not called from the client) wrapping Twilio's SMS API; called by `scheduled-release` for driver/passenger pickup reminders. No-ops quietly if Twilio secrets aren't configured.
- **`stripe-webhook`** — Verifies Stripe's HMAC signature (rejecting payloads >5 min old) and syncs `rides.payment_status` on `payment_intent.succeeded` / `.payment_failed` / `.canceled` and `charge.refunded` events.

**Legacy/dead (superseded, unscheduled — safe to delete):** `scheduled-lifecycle` (old unified cron: fixed T-30/T-15 reminders, travel-time auto-start, 60-min unclaimed escalation via an `escalated` flag), `process-scheduled-rides`, `scheduled-ride-reminders` (read a nonexistent `profiles.expo_push_token` column), `schedule-rides`.
