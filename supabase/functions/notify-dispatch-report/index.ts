import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FROM_ADDRESS = "no-reply@vellon.ca";
const TO_ADDRESS = "support@vellon.ca";

const CATEGORY_LABELS: Record<string, string> = {
  bug: "Bug / technical issue",
  driver_issue: "Driver issue",
  billing: "Payment / billing",
  feature_request: "Feature request",
  other: "Other",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface ReportWebhookPayload {
  type: string;
  table: string;
  record: {
    id: string;
    company_id: string;
    admin_id: string;
    category: string;
    message: string;
    created_at: string;
  };
}

Deno.serve(async (req) => {
  try {
    const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
    const incomingSecret = req.headers.get("x-webhook-secret");
    if (!webhookSecret || incomingSecret !== webhookSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload: ReportWebhookPayload = await req.json();
    const report = payload.record;

    const [{ data: company }, { data: admin }] = await Promise.all([
      supabase.from("companies").select("name").eq("id", report.company_id).maybeSingle(),
      supabase.from("profiles").select("name").eq("id", report.admin_id).maybeSingle(),
    ]);

    const categoryLabel = CATEGORY_LABELS[report.category] ?? report.category;
    const companyName = company?.name ?? "Unknown company";
    const adminName = admin?.name ?? "Unknown admin";

    const html = `
      <div style="font-family: system-ui, sans-serif; color: #111827;">
        <h2 style="margin-bottom: 4px;">New dispatch report</h2>
        <p style="color: #6B7280; margin-top: 0;">${esc(categoryLabel)}</p>
        <table style="border-collapse: collapse; margin: 12px 0;">
          <tr><td style="color: #6B7280; padding: 2px 12px 2px 0;">Company</td><td>${esc(companyName)}</td></tr>
          <tr><td style="color: #6B7280; padding: 2px 12px 2px 0;">Submitted by</td><td>${esc(adminName)}</td></tr>
          <tr><td style="color: #6B7280; padding: 2px 12px 2px 0;">Time</td><td>${esc(report.created_at)}</td></tr>
        </table>
        <p style="white-space: pre-wrap; border-left: 3px solid #E8500A; padding-left: 12px;">${esc(report.message)}</p>
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject: `[Dispatch report] ${categoryLabel} — ${companyName}`,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[notify-dispatch-report] Resend error:", errText);
      return new Response(JSON.stringify({ error: errText }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("[notify-dispatch-report] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
