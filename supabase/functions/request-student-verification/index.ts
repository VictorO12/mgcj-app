import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_ADDRESS = "no-reply@vellon.ca";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: "email is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const domain = normalizedEmail.split("@")[1];
    if (!domain) {
      return new Response(JSON.stringify({ error: "Please enter a valid email address" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: institution, error: institutionError } = await serviceClient
      .from("institutions")
      .select("id, name, domain")
      .eq("domain", domain)
      .maybeSingle();

    if (institutionError || !institution) {
      return new Response(
        JSON.stringify({ error: "We don't recognize that school email domain yet. Contact support if your school should be included." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Email already verified on a different account
    const { data: existing } = await serviceClient
      .from("profiles")
      .select("id")
      .eq("student_email", normalizedEmail)
      .neq("id", user.id)
      .maybeSingle();

    if (existing) {
      return new Response(
        JSON.stringify({ error: "This email is already verified on another account" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const { error: tokenError } = await serviceClient
      .from("student_verification_tokens")
      .insert({
        user_id: user.id,
        institution_id: institution.id,
        email: normalizedEmail,
        token,
        expires_at: expiresAt,
      });

    if (tokenError) {
      console.error("[request-student-verification] token insert error:", tokenError);
      return new Response(JSON.stringify({ error: "Could not start verification" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const confirmUrl = `${SUPABASE_URL}/functions/v1/confirm-student-verification?token=${token}`;

    // Look up company name from the passenger's profile
    let companyName = "Vellon";
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.company_id) {
      const { data: company } = await serviceClient
        .from("companies")
        .select("name")
        .eq("id", profile.company_id)
        .maybeSingle();
      if (company?.name) companyName = company.name;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: normalizedEmail,
        subject: `Confirm your student discount — ${companyName}`,
        html: buildEmailHtml(institution.name, confirmUrl, companyName),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[request-student-verification] Resend error:", errText);
      return new Response(JSON.stringify({ error: "Could not send confirmation email" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[request-student-verification] error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function buildEmailHtml(institutionName: string, confirmUrl: string, companyName: string) {
  return `
  <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
    <div style="text-align: center; padding: 24px 0;">
      <h1 style="font-size: 20px; margin: 0; color: #1a1a1a;">${companyName}</h1>
      <p style="color: #6B7280; font-size: 13px; margin-top: 4px;">Student Discount Verification</p>
    </div>
    <p style="font-size: 14px;">Confirm your ${institutionName} email to activate your student discount.</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${confirmUrl}" style="background: #E8500A; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">Confirm my student status</a>
    </div>
    <p style="font-size: 12px; color: #9CA3AF;">This link expires in 30 minutes. If you didn't request this, you can ignore this email.</p>
  </div>
  `;
}
