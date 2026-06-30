import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FROM_ADDRESS = "no-reply@vellon.ca";

interface RideWebhookPayload {
  type: string;
  table: string;
  record: {
    id: string;
    passenger_id: string;
    driver_id: string | null;
    company_id: string | null;
    status: string;
    pickup_address: string;
    dropoff_address: string;
    fare_final: number | null;
    fare_estimate: number | null;
    payment_method: string;
    created_at: string;
    completed_at?: string;
  };
  old_record: { status: string } | null;
}

Deno.serve(async (req) => {
  try {
    const payload: RideWebhookPayload = await req.json();
    const ride = payload.record;

    if (ride.status !== "completed") {
      return new Response(JSON.stringify({ skipped: "not completed" }), { status: 200 });
    }
    if (payload.old_record?.status === "completed") {
      return new Response(JSON.stringify({ skipped: "already completed" }), { status: 200 });
    }

    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, email")
      .eq("id", ride.passenger_id)
      .maybeSingle();

    if (!passenger?.email) {
      return new Response(JSON.stringify({ skipped: "no passenger email" }), { status: 200 });
    }

    let driverName: string | null = null;
    if (ride.driver_id) {
      const { data: driver } = await supabase
        .from("profiles")
        .select("name")
        .eq("id", ride.driver_id)
        .maybeSingle();
      driverName = driver?.name ?? null;
    }

    let companyName = "Your Taxi";
    let hstNumber: string | null = null;
    if (ride.company_id) {
      const { data: company } = await supabase
        .from("companies")
        .select("name, hst_number")
        .eq("id", ride.company_id)
        .maybeSingle();
      if (company?.name) companyName = company.name;
      hstNumber = company?.hst_number ?? null;
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
    const shortDate = new Date(ride.created_at).toLocaleDateString("en-CA", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = buildReceiptHtml({
      passengerName: passenger.name ?? "there",
      driverName,
      pickup: ride.pickup_address,
      dropoff: ride.dropoff_address,
      fare,
      paymentMethod: ride.payment_method,
      date,
      companyName,
    });

    const invoiceNumber = `INV-${ride.id.slice(0, 8).toUpperCase()}`;
    const pdfBytes = await buildInvoicePdf({
      invoiceNumber,
      date: shortDate,
      passengerName: passenger.name ?? "Passenger",
      companyName,
      hstNumber,
      pickup: ride.pickup_address,
      dropoff: ride.dropoff_address,
      fare,
      paymentMethod: ride.payment_method,
    });

    const base64Pdf = btoa(pdfBytes.reduce((acc, byte) => acc + String.fromCharCode(byte), ""));

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: passenger.email,
        subject: `Your ride receipt — $${fare.toFixed(2)}`,
        html,
        attachments: [
          {
            filename: `${invoiceNumber}.pdf`,
            content: base64Pdf,
            content_type: "application/pdf",
          },
        ],
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

async function buildInvoicePdf(params: {
  invoiceNumber: string;
  date: string;
  passengerName: string;
  companyName: string;
  hstNumber: string | null;
  pickup: string;
  dropoff: string;
  fare: number;
  paymentMethod: string;
}): Promise<Uint8Array> {
  const { invoiceNumber, date, passengerName, companyName, hstNumber, pickup, dropoff, fare, paymentMethod } = params;

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // Letter

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.45, 0.45, 0.45);
  const lightGray = rgb(0.94, 0.94, 0.94);
  const green = rgb(0.07, 0.62, 0.46);

  const left = 50;
  const right = 562;
  const W = right - left;

  const draw = (
    text: string,
    x: number,
    y: number,
    opts: { size?: number; font?: typeof regular; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
  ) => {
    const { size = 11, font = regular, color = black, align = "left" } = opts;
    const drawX = align === "right" ? x - font.widthOfTextAtSize(text, size) : x;
    page.drawText(text, { x: drawX, y, size, font, color });
  };

  const rule = (y: number, color = lightGray) => {
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color });
  };

  const subtotal = fare / 1.15;
  const hst = fare - subtotal;

  let y = 742;

  // ── Header ────────────────────────────────────────────────────────────
  draw(companyName, left, y, { size: 18, font: bold });
  draw("INVOICE", right, y, { size: 20, font: bold, align: "right" });

  y -= 20;
  if (hstNumber) {
    draw(`HST Reg: ${hstNumber}`, left, y, { size: 9, color: gray });
  }
  draw(invoiceNumber, right, y, { size: 10, color: gray, align: "right" });

  y -= 14;
  draw(date, right, y, { size: 10, color: gray, align: "right" });

  y -= 18;
  rule(y);

  // ── Bill To ───────────────────────────────────────────────────────────
  y -= 16;
  draw("BILL TO", left, y, { size: 9, color: gray });

  y -= 16;
  draw(passengerName, left, y, { size: 13, font: bold });

  y -= 26;
  rule(y);

  // ── Ride Details ──────────────────────────────────────────────────────
  y -= 16;
  draw("RIDE DETAILS", left, y, { size: 9, color: gray });

  y -= 17;
  draw("Pickup", left, y, { size: 9, color: gray });
  draw(pickup.length > 75 ? pickup.slice(0, 72) + "…" : pickup, left + 72, y, { size: 10 });

  y -= 16;
  draw("Drop-off", left, y, { size: 9, color: gray });
  draw(dropoff.length > 75 ? dropoff.slice(0, 72) + "…" : dropoff, left + 72, y, { size: 10 });

  y -= 24;
  rule(y);

  // ── Line items ────────────────────────────────────────────────────────
  y -= 14;
  page.drawRectangle({ x: left, y: y - 5, width: W, height: 20, color: lightGray });
  draw("Description", left + 6, y, { size: 9, color: gray });
  draw("Amount", right - 6, y, { size: 9, color: gray, align: "right" });

  y -= 24;
  draw("Taxi fare", left + 6, y, { size: 11 });
  draw(`$${fare.toFixed(2)}`, right - 6, y, { size: 11, align: "right" });

  y -= 20;
  draw("  Subtotal (before HST)", left + 6, y, { size: 10, color: gray });
  draw(`$${subtotal.toFixed(2)}`, right - 6, y, { size: 10, color: gray, align: "right" });

  y -= 16;
  draw("  HST (15%)", left + 6, y, { size: 10, color: gray });
  draw(`$${hst.toFixed(2)}`, right - 6, y, { size: 10, color: gray, align: "right" });

  y -= 22;
  rule(y, rgb(0.8, 0.8, 0.8));

  // ── Total ─────────────────────────────────────────────────────────────
  y -= 18;
  draw("Total", left + 6, y, { size: 13, font: bold });
  draw(`$${fare.toFixed(2)}`, right - 6, y, { size: 13, font: bold, align: "right" });

  y -= 22;
  rule(y);

  // ── Payment status ────────────────────────────────────────────────────
  y -= 22;
  const payLabel = paymentMethod === "cash" ? "Cash — paid to driver" : "Card payment";
  draw(`Payment: ${payLabel}`, left, y, { size: 11, color: gray });

  y -= 20;
  draw("PAID", left, y, { size: 13, font: bold, color: green });

  // ── Footer ────────────────────────────────────────────────────────────
  rule(62);
  draw(`Issued by ${companyName} via Vellon dispatch platform`, left, 50, { size: 8, color: gray });

  return doc.save();
}

function buildReceiptHtml(params: {
  passengerName: string;
  driverName: string | null;
  pickup: string;
  dropoff: string;
  fare: number;
  paymentMethod: string;
  date: string;
  companyName: string;
}) {
  const { passengerName, driverName, pickup, dropoff, fare, paymentMethod, date, companyName } = params;

  return `
  <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
    <div style="text-align: center; padding: 24px 0;">
      <h1 style="font-size: 20px; margin: 0; color: #1a1a1a;">${companyName}</h1>
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
      ${companyName}
    </p>
  </div>
  `;
}
