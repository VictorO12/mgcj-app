// Cron janitor. Two jobs it always had (expire unclaimed immediate rides,
// retry stale ones, cancel missed scheduled rides) plus three sweeps added
// with settle-ride, all of which exist to remove a human or a phone from the
// critical path:
//
//   Sweep A — cancelled rides whose Stripe hold was never released. The
//     backstop for any cancel that bypassed settle-ride (direct SQL, an older
//     client build still doing a bare .update({status:'cancelled'})).
//   Sweep B — completed card rides never captured. capture-payment is called
//     by the driver's app; a crash / dead battery / no signal meant the hold
//     sat until Stripe expired it and Vellon was never paid for a real ride.
//   Sweep C — rides stuck mid-flight that nobody closed out. Nothing reaped
//     'assigned'/'driver_arriving'/'in_progress' (the missed-schedule pass
//     below deliberately excludes them), so a passenger no-show with a driver
//     who never filed one left the ride terminal-stuck AND kept the driver in
//     every busy-set filter — one no-show removed a car from the fleet
//     indefinitely.
//
// All three route through settle-ride so the hold and the row can never
// disagree about whether a ride is over.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireServiceRole } from '../_shared/internalAuth.ts'

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const ASSIGN_RIDE_URL     = `${SUPABASE_URL}/functions/v1/assign-ride`;
const SETTLE_RIDE_URL     = `${SUPABASE_URL}/functions/v1/settle-ride`;
const CAPTURE_PAYMENT_URL = `${SUPABASE_URL}/functions/v1/capture-payment`;

const TIMEOUT_MINUTES         = 5;
const REBROADCAST_MINUTES     = 2;
const MISSED_SCHEDULE_MINUTES = 20;

// Sweep fuses. Generous on purpose — these fire only when every intended
// path (driver action, dispatch, the passenger's own app) has already failed.
const STRANDED_HOLD_MINUTES   = 10;   // cancelled but the hold is still live
const UNCAPTURED_MINUTES      = 10;   // completed, card, never captured
const STUCK_ASSIGNED_HOURS    = 2;    // accepted but the trip never started
const STUCK_IN_PROGRESS_HOURS = 6;    // a real Valley taxi ride is minutes
// A driver whose heartbeat is this old has effectively left. Deliberately far
// longer than PRESENCE_STALE_MS (60s, _shared/presence.ts): that threshold
// answers "can this driver receive an offer right now", which is a different
// and much twitchier question than "has this driver abandoned a live ride".
const DRIVER_ABANDONED_MINUTES = 30;

async function settle(rideId: string, action: string, reason?: string) {
  try {
    const res = await fetch(SETTLE_RIDE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ ride_id: rideId, action, reason }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error(`[expire-pending-rides] settle-ride ${action} failed for ${rideId}:`, body);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[expire-pending-rides] settle-ride ${action} threw for ${rideId}:`, e);
    return false;
  }
}

Deno.serve(async (req) => {
  // Cron/internal only — see _shared/internalAuth.ts. Without this the
  // function is reachable by anyone on the internet: verify_jwt = false in
  // config.toml disables the gateway check entirely.
  const denied = requireServiceRole(req)
  if (denied) return denied
  const now = new Date();
  const iso = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();

  const timeoutCutoff       = iso(TIMEOUT_MINUTES);
  const rebroadcastCutoff   = iso(REBROADCAST_MINUTES);
  const missedScheduleCutoff = iso(MISSED_SCHEDULE_MINUTES);

  let expiredCount = 0, missedCount = 0;
  let strandedCount = 0, capturedCount = 0, stuckCount = 0;

  // ── 1. Cancel rides pending > 5 minutes ─────────────────────
  // Includes 'offered' — a ride being actively cycled between drivers
  // by reassign-stale-rides is almost never caught sitting at 'pending'
  // long enough for this query to see it there.
  const { data: expiredRides, error: expiredError } = await supabase
    .from("rides")
    .select("id, passenger_id")
    .in("status", ["pending", "offered"])
    .is("scheduled_at", null)
    .lt("created_at", timeoutCutoff);

  if (expiredError) {
    console.error("[expire-pending-rides] fetch expired error:", expiredError);
  } else {
    for (const ride of expiredRides ?? []) {
      // Was a bulk .update({status:'cancelled'}) that never released the hold.
      if (!(await settle(ride.id, "cancel", "timeout"))) continue;
      expiredCount++;
      await sendPush(ride.passenger_id, {
        title: "No drivers available",
        body: "We couldn't find a driver nearby. Please try again in a few minutes.",
        data: { type: "ride_timeout" },
      });
    }
    if (expiredCount) console.log(`[expire-pending-rides] cancelled ${expiredCount} rides`);
  }

  // ── 2. Retry assignment for rides pending > 2 minutes ────────
  // These are rides that have been declined by all available drivers
  // or where assign-ride couldn't find anyone. Clear declined_by and
  // call assign-ride again to give all drivers another chance.
  const { data: staleRides, error: staleError } = await supabase
    .from("rides")
    .select("id, declined_by")
    .in("status", ["pending", "offered"])
    .is("scheduled_at", null)
    .lt("created_at", rebroadcastCutoff)
    .gte("created_at", timeoutCutoff); // not already in the expired bucket

  if (staleError) {
    console.error("[expire-pending-rides] fetch stale error:", staleError);
  } else if (staleRides && staleRides.length > 0) {
    console.log(`[expire-pending-rides] retrying assignment for ${staleRides.length} stale rides`);

    for (const ride of staleRides) {
      await supabase.from("rides").update({ declined_by: [] }).eq("id", ride.id);
      await fetch(ASSIGN_RIDE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ ride_id: ride.id }),
      });
    }
  }

  // ── 3. Cancel scheduled rides missed by >20 minutes with no driver underway ─
  // Covers rides never released ('scheduled') or released but never actually
  // engaged by a driver ('pending'/'offered'). Rides already 'assigned',
  // 'driver_arriving', or 'in_progress' are left alone — a driver has taken
  // action, even if running late, so this isn't a case of "nothing happened."
  // (Those are Sweep C's job, on a much longer fuse.)
  const { data: missedRides, error: missedError } = await supabase
    .from("rides")
    .select("id, passenger_id")
    .in("status", ["scheduled", "pending", "offered"])
    .not("scheduled_at", "is", null)
    .lt("scheduled_at", missedScheduleCutoff);

  if (missedError) {
    console.error("[expire-pending-rides] fetch missed-schedule error:", missedError);
  } else {
    for (const ride of missedRides ?? []) {
      // This was the worst offender: the system killed a ride it had created
      // a hold for, and left the passenger's money held for a week.
      if (!(await settle(ride.id, "cancel", "missed_window"))) continue;
      missedCount++;
      await sendPush(ride.passenger_id, {
        title: "Scheduled ride cancelled",
        body: "We couldn't find a driver in time for your scheduled pickup. Please rebook.",
        data: { type: "scheduled_missed" },
      });
    }
    if (missedCount) console.log(`[expire-pending-rides] cancelled ${missedCount} missed scheduled ride(s)`);
  }

  // ── Sweep A: cancelled rides with a hold nobody released ─────
  const { data: stranded } = await supabase
    .from("rides")
    .select("id")
    .eq("status", "cancelled")
    .not("stripe_payment_intent_id", "is", null)
    .in("payment_status", ["pending", "failed"])
    // NULL cancelled_at counts as sweepable: every ride cancelled before
    // migration 20260741 has none (no backfill, by design), and a `lt`
    // comparison would silently exclude exactly the population this sweep
    // exists for. Safe to include because release_hold stamps
    // payment_status='unpaid' on everything it touches, so each row drops out
    // of this query permanently after one pass.
    .or(`cancelled_at.is.null,cancelled_at.lt.${iso(STRANDED_HOLD_MINUTES)}`);

  for (const ride of stranded ?? []) {
    if (await settle(ride.id, "release_hold", "stranded")) strandedCount++;
  }
  if (strandedCount) console.log(`[expire-pending-rides] released ${strandedCount} stranded hold(s)`);

  // ── Sweep B: completed card rides the driver's app never captured ──
  // capture-payment is idempotent (Idempotency-Key `capture-<ride_id>`, plus
  // its requires_capture guard and recheck-before-marking-failed), so racing a
  // driver phone that reconnects late is safe.
  const { data: uncaptured } = await supabase
    .from("rides")
    .select("id")
    .eq("status", "completed")
    .eq("payment_method", "card")
    // 'failed' as well as 'pending': capture-payment writes 'failed' when a
    // capture attempt errors, so a ride whose capture was tried and failed
    // (the 2026-07-21 false-failed class) would otherwise never be swept and
    // its hold would sit until Stripe expired it.
    .in("payment_status", ["pending", "failed"])
    .not("stripe_payment_intent_id", "is", null)
    .lt("completed_at", iso(UNCAPTURED_MINUTES));

  for (const ride of uncaptured ?? []) {
    try {
      const res = await fetch(CAPTURE_PAYMENT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ ride_id: ride.id }),
      });
      if (res.ok) capturedCount++;
      else console.error(`[expire-pending-rides] sweep capture failed for ${ride.id}:`, await res.text());
    } catch (e) {
      console.error(`[expire-pending-rides] sweep capture threw for ${ride.id}:`, e);
    }
  }
  if (capturedCount) console.log(`[expire-pending-rides] swept ${capturedCount} uncaptured ride(s)`);

  // ── Sweep C: rides stuck mid-flight ──────────────────────────
  // The driver's own no-show action is the fast path; this is what happens
  // when the driver files nothing at all (app crash, phone dead, went
  // offline). Without it the fix would just move the dependency from dispatch
  // onto the driver's phone.
  const { data: stuckCandidates } = await supabase
    .from("rides")
    .select("id, status, driver_id, assigned_at, arrived_at, scheduled_at, created_at")
    .in("status", ["assigned", "driver_arriving", "in_progress"]);

  const abandonedCutoff = new Date(now.getTime() - DRIVER_ABANDONED_MINUTES * 60_000);

  for (const ride of stuckCandidates ?? []) {
    // Age from the most recent thing that actually happened to the ride.
    // assigned_at/arrived_at are NULL on every row that predates migration
    // 20260741, and there is deliberately no backfill (an invented stamp is
    // worse than none). The fallback chain must therefore never land on a
    // timestamp in the FUTURE: a scheduled ride booked weeks out has a
    // scheduled_at ahead of now, which would make ageHours negative and the
    // ride permanently unsweepable. created_at is always in the past, so it
    // is the floor, and the anchor is the latest stamp that has passed.
    const candidates = [ride.arrived_at, ride.assigned_at, ride.scheduled_at, ride.created_at]
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime())
      .filter((t) => t <= now.getTime());
    const anchor = candidates.length ? Math.max(...candidates) : new Date(ride.created_at).getTime();
    const ageHours = (now.getTime() - anchor) / 3_600_000;

    const fuse = ride.status === "in_progress" ? STUCK_IN_PROGRESS_HOURS : STUCK_ASSIGNED_HOURS;
    if (ageHours < fuse) continue;

    // An in-progress ride whose driver is still heartbeating is plausibly a
    // real long trip, not an abandoned one — give it a much longer rope
    // rather than cancelling a ride that is actually happening.
    if (ride.status === "in_progress" && ride.driver_id) {
      const { data: driver } = await supabase
        .from("drivers")
        .select("last_seen_at")
        .eq("id", ride.driver_id)
        .maybeSingle();
      const stillLive =
        driver?.last_seen_at != null && new Date(driver.last_seen_at) > abandonedCutoff;
      if (stillLive && ageHours < STUCK_IN_PROGRESS_HOURS * 2) continue;
    }

    // NOTE: an in-progress ride swept here probably DID happen — the driver
    // just never tapped complete. Releasing the hold is the right call for the
    // passenger (never hold money on a ride nobody can account for), but it
    // means the driver isn't paid for possible real work. 'stuck' is a
    // distinct reason code precisely so these are findable and can be made
    // whole by hand; they should be rare enough to review individually.
    if (await settle(ride.id, "cancel", "stuck")) {
      stuckCount++;
      console.warn(
        `[expire-pending-rides] STUCK ride ${ride.id} (${ride.status}, ${ageHours.toFixed(1)}h) cancelled — review for driver make-good`,
      );
    }
  }

  return new Response(
    JSON.stringify({
      expired:   expiredCount,
      retried:   staleRides?.length ?? 0,
      missed:    missedCount,
      stranded:  strandedCount,
      captured:  capturedCount,
      stuck:     stuckCount,
    }),
    { status: 200 },
  );
});

async function sendPush(
  userId: string,
  notification: { title: string; body: string; data: object },
) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("push_token")
    .eq("id", userId)
    .maybeSingle();

  const token = profile?.push_token;
  if (!token) return;

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: token, sound: "default", ...notification }),
    });
  } catch (e) {
    console.error("[expire-pending-rides] push error:", e);
  }
}
