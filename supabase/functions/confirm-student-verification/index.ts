import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return htmlResponse("Missing confirmation link.", 400);
  }

  const serviceClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: tokenRow, error: tokenError } = await serviceClient
    .from("student_verification_tokens")
    .select("id, user_id, institution_id, email, expires_at, consumed_at")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return htmlResponse("This confirmation link is invalid.", 400);
  }

  if (tokenRow.consumed_at) {
    return htmlResponse("This confirmation link has already been used.", 400);
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return htmlResponse("This confirmation link has expired. Please request a new one in the app.", 400);
  }

  // Re-check email uniqueness at confirm time in case of a race
  const { data: existing } = await serviceClient
    .from("profiles")
    .select("id")
    .eq("student_email", tokenRow.email)
    .neq("id", tokenRow.user_id)
    .maybeSingle();

  if (existing) {
    return htmlResponse("This email is already verified on another account.", 409);
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
    return htmlResponse("Something went wrong confirming your student status. Please try again.", 500);
  }

  await serviceClient
    .from("student_verification_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return htmlResponse("Your student discount is now active. You can close this page and return to the app.", 200, true);
});

function htmlResponse(message: string, status: number, success = false) {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>M&amp;G C&amp;J — Student Verification</title>
  </head>
  <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; background: #111827; color: white; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh;">
    <div style="max-width: 360px; text-align: center; padding: 32px;">
      <h1 style="font-size: 20px; color: #E8500A; margin: 0 0 16px;">M&amp;G C&amp;J</h1>
      <p style="font-size: 16px; color: ${success ? "#1D9E75" : "#F87171"};">${message}</p>
    </div>
  </body>
  </html>
  `;
  return new Response(html, { status, headers: { "Content-Type": "text/html" } });
}
