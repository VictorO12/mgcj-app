import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const VERIFY_BASE_URL = "https://mgcj-dashboard.vercel.app/verify.html";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return redirect("This confirmation link is invalid.");
  }

  const serviceClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: tokenRow, error: tokenError } = await serviceClient
    .from("student_verification_tokens")
    .select("id, user_id, institution_id, email, expires_at, consumed_at")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return redirect("This confirmation link is invalid.");
  }

  if (tokenRow.consumed_at) {
    // Email clients pre-fetch links — if the profile is already verified, show success
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("student_verified")
      .eq("id", tokenRow.user_id)
      .maybeSingle();
    if (profile?.student_verified) {
      return redirect("Your student discount is now active. You can close this page and return to the app.", true);
    }
    return redirect("This confirmation link has already been used.");
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return redirect("This confirmation link has expired. Please request a new one in the app.");
  }

  // Re-check email uniqueness at confirm time in case of a race
  const { data: existing } = await serviceClient
    .from("profiles")
    .select("id")
    .eq("student_email", tokenRow.email)
    .neq("id", tokenRow.user_id)
    .maybeSingle();

  if (existing) {
    return redirect("This email is already verified on another account.");
  }

  const { error: updateError } = await serviceClient
    .from("profiles")
    .update({
      student_verified: true,
      student_email: tokenRow.email,
      student_institution_id: tokenRow.institution_id,
      student_verified_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.user_id);

  if (updateError) {
    console.error("[confirm-student-verification] profile update error:", updateError);
    return redirect("Something went wrong confirming your student status. Please try again.");
  }

  await serviceClient
    .from("student_verification_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return redirect("Your student discount is now active. You can close this page and return to the app.", true);
});

function redirect(message: string, success = false) {
  const url = new URL(VERIFY_BASE_URL);
  url.searchParams.set("success", success ? "1" : "0");
  url.searchParams.set("message", message);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": url.toString(),
      "Cache-Control": "no-store, no-cache",
    },
  });
}
