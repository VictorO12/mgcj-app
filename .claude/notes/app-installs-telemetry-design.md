# Fleet install inventory — design (not built)

Queued 2026-08-23 for its own session. Origin: after the OTA crash test, reading a
device's state required asking Victor to long-press a version line and read it out.
That does not scale to customers.

## Scope it correctly: the ask is INVENTORY, not logs

The stated pain is "instead of having to ask a customer to hold on the version and tell
us what it says". That is answered completely by knowing what every device is running,
at all times. The 381-entry update log is mostly routine check chatter; the one valuable
line was the running update id, which the version string already carries.

So Phase 1 is **one row per install, upserted on launch** — and it alone removes the
phone call. Phases 2–3 below are not foreclosed by it.

## Phase 1 — `app_installs`

```
install_id        uuid   -- generated once, persisted on device  (PK)
profile_id        uuid   -- current occupant; MAY CHANGE over time
role, company_id
platform, os_version, device_model
app_version, build_number, channel
update_id, update_created_at, is_embedded
last_launch_at    timestamptz
```

Written on launch, and again after an OTA applies. Answers without contacting anyone:
what is this driver running, did a fix reach the fleet, how many devices are still on a
bad bundle.

### Install identity — the decision that shapes the schema

Three candidate keys; two are traps.

- **`drivers.device_token` — no.** It is the single-device *lock* token, claimed and
  cleared as part of session enforcement, so an install loses its identity on every
  sign-out and duplicates. It also lives on `drivers`; passengers have none.
- **`profile_id` — no.** Breaks the bounding property outright: `signInAnonymously()`
  creates a real `auth.users` row per guest-booking session, so one shared phone at a
  taxi stand generates unbounded rows.
- **A dedicated install uuid — yes.** Survives sign-out, works for both roles, one row
  per phone. Store in **AsyncStorage, NOT SecureStore** — it is not a secret, and
  SecureStore is where the `@`-in-key trap silently killed the device lock for six weeks
  ([[securestore-key-charset-throws]]). A reinstall creating a new row is correct.

Confirmed nothing suitable exists today: `generateUUID()` (`DriverApp.tsx:93`) feeds the
device-lock token at line 235 and is not persisted as an install id.

### The blind spot — design it in now, not later

**A device that cannot launch never reports.** For a crashing *embedded* bundle — the
scar-tissue case the whole OTA effort exists for — you get silence, permanently.

Detection is therefore **absence**: installs whose reports go stale immediately after a
publish. That is only readable if `last_launch_at` is per-install and the fleet can be
diffed against a publish time. Schema requirement, not an afterthought.

### Constraints

- **Do not name the timestamp `last_seen_at`.** That name already means the driver
  heartbeat on `drivers`. This codebase has been bitten by exactly this collision twice
  (`updated_at`→`completed_at`, `updated_at`→`last_seen_at`). Use `last_launch_at`.
- **Separate table — never columns on `drivers`/`profiles`.** Multi-device breaks the
  one-row assumption, and writing on every launch would bump `updated_at` on hot rows,
  the anti-pattern the `completed_at` migration exists to fix.
- **Bounded by device count, not by time.** The 2GB free tier already lost 94% of its
  usage to `cron.job_run_details`; no continuous log ingestion.
- New table ⇒ explicit `GRANT`s in the same migration (post-Oct-2026 rule), plus RLS.
- Read from **vellon-ops** via the existing service-role connector — it is the internal
  back office and already a spoke into this project.

## Phase 2 — error-log upload (deliberately later)

On launch, read `Updates.readLogEntriesAsync()`, filter to error/fatal, upload what has
not been sent. **Watermark by timestamp, not an "uploaded" boolean** — see the test-11
lesson about a persisted key whose identity never resets.

The insight that makes this work at all: a crashing bundle cannot self-report, since no
JS runs. But after expo-updates' automatic error recovery reverts, the *good* bundle can
read the native log and upload the crash and the rollback. That is exactly how the
`JSRuntimeError` observed on 2026-08-23 would have reached us unprompted. Note this
covers the bad-OTA case only — not the crashing-embedded-bundle case above.

## Phase 3 — diagnostics attached to a report

Attach build identity + recent log entries to `dispatch_reports` on submit. Bounded
per-report rather than continuous.

## Not chosen: Sentry

Sentry answers "why did it crash" — stack traces, breadcrumbs, release health — which is
a different question from "what are they running", and nobody has asked it yet. It is
the right tool if/when crash *causes* become the bottleneck. Named here so the option
isn't rediscovered from scratch.
