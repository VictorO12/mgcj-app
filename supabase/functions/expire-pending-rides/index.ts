import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ASSIGN_RIDE_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/assign-ride`;
const TIMEOUT_MINUTES = 5;
const REBROADCAST_MINUTES = 2;

Deno.serve(async () => {
  const now = new Date();
  const timeoutCutoff = new Date(now.getTime() - TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const rebroadcastCutoff = new Date(now.getTime() - REBROADCAST_MINUTES * 60 * 1000).toISOString();

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
  } else if (expiredRides && expiredRides.length > 0) {
    const expiredIds = expiredRides.map((r) => r.id);
    await supabase
      .from("rides")
      .update({ status: "cancelled", cancelled_reason: "timeout" })
      .in("id", expiredIds);

    for (const ride of expiredRides) {
      await sendPush(ride.passenger_id, {
        title: "No drivers available",
        body: "We couldn't find a driver nearby. Please try again in a few minutes.",
        data: { type: "ride_timeout" },
      });
    }
    console.log(`[expire-pending-rides] cancelled ${expiredIds.length} rides`);
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
      // Clear declined_by so all drivers get another chance
      await supabase
        .from("rides")
        .update({ declined_by: [] })
        .eq("id", ride.id);

      // Actively call assign-ride rather than passively waiting
      await fetch(ASSIGN_RIDE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ ride_id: ride.id }),
      });

      console.log(`[expire-pending-rides] re-triggered assign-ride for ${ride.id}`);
    }
  }

  return new Response(
    JSON.stringify({
      expired: expiredRides?.length ?? 0,
      retried: staleRides?.length ?? 0,
    }),
    { status: 200 }
  );
});

async function sendPush(
  userId: string,
  notification: { title: string; body: string; data: object }
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