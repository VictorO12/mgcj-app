import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Remind passengers whose ride is between 25 and 35 minutes away
const WINDOW_MIN = 25;
const WINDOW_MAX = 35;

Deno.serve(async () => {
  const now = new Date();
  const windowStart = new Date(now.getTime() + WINDOW_MIN * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + WINDOW_MAX * 60 * 1000).toISOString();

  // Find scheduled rides in the reminder window not yet reminded
  const { data: rides, error } = await supabase
    .from("rides")
    .select("id, passenger_id, scheduled_at, pickup_address")
    .in("status", ["pending", "assigned"])
    .eq("reminder_sent", false)
    .gte("scheduled_at", windowStart)
    .lte("scheduled_at", windowEnd);

  if (error) {
    console.error("[scheduled-ride-reminders] fetch error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!rides || rides.length === 0) {
    return new Response(JSON.stringify({ reminded: 0 }), { status: 200 });
  }

  let reminded = 0;

  for (const ride of rides) {
    // Mark reminder sent first to avoid double-sending if function runs twice
    const { error: flagError } = await supabase
      .from("rides")
      .update({ reminder_sent: true })
      .eq("id", ride.id);

    if (flagError) {
      console.error("[scheduled-ride-reminders] flag error:", flagError);
      continue;
    }

    await notifyPassenger(ride.passenger_id, ride.scheduled_at, ride.pickup_address);
    reminded++;
  }

  console.log(`[scheduled-ride-reminders] reminded ${reminded} passengers`);
  return new Response(JSON.stringify({ reminded }), { status: 200 });
});

async function notifyPassenger(
  passengerId: string,
  scheduledAt: string,
  pickupAddress: string,
) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("expo_push_token")
    .eq("id", passengerId)
    .maybeSingle();

  const token = profile?.expo_push_token;
  if (!token) return;

  const time = new Date(scheduledAt).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  });

  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        title: "Your ride is in 30 minutes",
        body: `Pickup at ${pickupAddress} at ${time}. Get ready!`,
        sound: "default",
        data: { type: "ride_reminder" },
      }),
    });
  } catch (e) {
    console.error("[scheduled-ride-reminders] push error:", e);
  }
}