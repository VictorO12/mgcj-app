// Admin-driven DISPATCHER provisioning (no self-serve signup, unlike drivers).
// Only an existing admin can call this, and it creates DISPATCHERS only —
// admin accounts are a vendor-managed seat (Vellon provisions them via service
// role / SQL), so this dashboard path can never mint an admin. Creates the auth
// user directly (phone, no password/OTP) and the matching profiles row in one
// step, so the new dispatcher can log straight in via the normal phone/OTP
// LoginPage flow — role ('dispatcher') and company_id are already stamped.
//
// Called from the browser dashboard, so it must handle the CORS preflight and
// be deployed with verify_jwt = false (see config.toml) — the preflight OPTIONS
// carries no Authorization header, so gateway JWT verification would 401 it
// before this code runs. We verify the caller's JWT + admin role in-function
// instead, so gateway verification is redundant anyway.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? raw : `+${digits}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const callerId = userData.user.id

    const { data: caller, error: callerError } = await supabase
      .from('profiles')
      .select('role, company_id')
      .eq('id', callerId)
      .maybeSingle()

    if (callerError || !caller || caller.role !== 'admin' || !caller.company_id) {
      return json({ error: 'Forbidden — admin only' }, 403)
    }

    const { name, phone } = await req.json()
    if (!name?.trim() || !phone?.trim()) {
      return json({ error: 'name and phone are required' }, 400)
    }
    // Dashboard provisioning creates dispatchers only — admins are vendor-managed.
    const role = 'dispatcher'

    const e164 = toE164(phone)
    if (e164.replace(/\D/g, '').length < 11) {
      return json({ error: 'Invalid phone number' }, 400)
    }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      phone: e164,
      phone_confirm: true,
    })

    if (createError || !created?.user) {
      const message = createError?.message?.includes('already been registered')
        ? 'A user with this phone number already exists'
        : (createError?.message ?? 'Failed to create account')
      return json({ error: message }, 409)
    }

    const newUserId = created.user.id

    // Upsert, not insert: this project has a trigger that auto-creates a bare
    // profiles row on auth.users insert (same reason OTPVerifyScreen.tsx upserts
    // with onConflict:"id"), so createUser() above may have already made the row.
    // A plain insert would hit a duplicate-key on profiles_pkey.
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: newUserId,
        company_id: caller.company_id,
        role,
        name: name.trim(),
        phone: e164,
      }, { onConflict: 'id' })

    if (profileError) {
      // Roll back the auth user so we don't leave an orphaned account with a
      // half-populated (trigger-created) profile row.
      await supabase.auth.admin.deleteUser(newUserId)
      return json({ error: profileError.message }, 500)
    }

    const { error: logError } = await supabase.from('dispatch_events').insert({
      company_id: caller.company_id,
      dispatcher_id: callerId,
      event_type: 'staff.created',
      details: { staff_id: newUserId, role, name: name.trim() },
    })
    if (logError) console.error('dispatch_events log error:', logError)

    console.log(`Staff account created: ${newUserId} (${role}) by admin ${callerId}`)
    return json({ success: true, id: newUserId }, 200)
  } catch (error) {
    console.error('create-staff-account error:', error)
    return json({ error: error.message }, 500)
  }
})
