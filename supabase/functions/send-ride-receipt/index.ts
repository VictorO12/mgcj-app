import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
// Update once you've verified a domain in Resend.
// Until then, Resend's test address only delivers to your own account email.
const FROM_ADDRESS = "M&G C&J <onboarding@resend.dev>";

interface RideWebhookPayload {
  type: string;
  table: string;
  record: {
    id: string;
    passenger_id: string;
    driver_id: string | null;
    status: string;
    pickup_address: string;
    dropoff_address: string;
    fare_final: number | null;
    fare_estimate: number | null;
    payment_method: string;
    created_at: string;
    completed_at?: string;
  };
  old_record: {
    status: string;
  } | null;
}

Deno.serve(async (req) => {
  try {
    const payload: RideWebhookPayload = await req.json();
    const ride = payload.record;

    // Only fire when status transitions TO completed
    if (ride.status !== "completed") {
      return new Response(JSON.stringify({ skipped: "not completed" }), { status: 200 });
    }
    if (payload.old_record?.status === "completed") {
      return new Response(JSON.stringify({ skipped: "already completed" }), { status: 200 });
    }

    // Fetch passenger email
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, email")
      .eq("id", ride.passenger_id)
      .maybeSingle();

    if (!passenger?.email) {
      return new Response(JSON.stringify({ skipped: "no passenger email" }), { status: 200 });
    }

    // Fetch driver name (optional, for display)
    let driverName: string | null = null;
    if (ride.driver_id) {
      const { data: driver } = await supabase
        .from("profiles")
        .select("name")
        .eq("id", ride.driver_id)
        .maybeSingle();
      driverName = driver?.name ?? null;
    }

    const fare = ride.fare_final ?? ride.fare_estimate ?? 0;
    const date = new Date(ride.created_at).toLocaleString("en-CA", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    const html = buildReceiptHtml({
      passengerName: passenger.name ?? "there",
      driverName,
      pickup: ride.pickup_address,
      dropoff: ride.dropoff_address,
      fare,
      paymentMethod: ride.payment_method,
      date,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: passenger.email,
        subject: `Your ride receipt — $${fare.toFixed(2)}`,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[send-ride-receipt] Resend error:", errText);
      return new Response(JSON.stringify({ error: errText }), { status: 500 });
    }

    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (e) {
    console.error("[send-ride-receipt] error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});

function buildReceiptHtml(params: {
  passengerName: string;
  driverName: string | null;
  pickup: string;
  dropoff: string;
  fare: number;
  paymentMethod: string;
  date: string;
}) {
  const { passengerName, driverName, pickup, dropoff, fare, paymentMethod, date } = params;

  return `
  <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
    <div style="text-align: center; padding: 24px 0;">
      <h1 style="font-size: 20px; margin: 0; color: #E8500A;">M&amp;G C&amp;J</h1>
      <p style="color: #6B7280; font-size: 13px; margin-top: 4px;">Ride Receipt</p>
    </div>

    <div style="background: #f7f7f7; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">Total fare</p>
      <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a;">$${fare.toFixed(2)}</p>
      <p style="margin: 4px 0 0; font-size: 13px; color: #6B7280; text-transform: capitalize;">
        Paid by ${paymentMethod}
      </p>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px; width: 100px;">Date</td>
        <td style="padding: 8px 0; font-size: 13px;">${date}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">Pickup</td>
        <td style="padding: 8px 0; font-size: 13px;">${pickup}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">Drop-off</td>
        <td style="padding: 8px 0; font-size: 13px;">${dropoff}</td>
      </tr>
      ${driverName ? `
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Driver</td>
        <td style="padding: 8px 0; font-size: 13px;">${driverName}</td>
      </tr>` : ""}
    </table>

    <p style="font-size: 12px; color: #9CA3AF; text-align: center; margin-top: 24px;">
      Thanks for riding with us, ${passengerName}!<br/>
      M&amp;G Cab Ltd &middot; C&amp;J Taxi Ltd &middot; Annapolis Valley, NS
    </p>
  </div>
  `;
}