// Admin-driven edit of a DISPATCHER's name and phone. Admin-only, service role.
//
// Scoped to dispatchers only (admins are a vendor-managed seat — an admin can't
// edit another admin, matching the RLS on profiles). Phone is the auth-login
// identity, so changing it requires updating auth.users via the admin API, not
// just the profiles row — hence this runs server-side rather than a client write.
//
// Browser-called, so it handles the CORS preflight and is deployed with
// verify_jwt = false (see config.toml); the caller's JWT + admin role are
// verified in-function.
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

    const { staff_id, name, phone } = await req.json()
    if (!staff_id) return json({ error: 'staff_id is required' }, 400)
    if (!name?.trim() || !phone?.trim()) {
      return json({ error: 'name and phone are required' }, 400)
    }

    // Target must be a dispatcher in the caller's own company.
    const { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('role, company_id, name, phone')
      .eq('id', staff_id)
      .maybeSingle()

    if (targetError || !target) return json({ error: 'Staff member not found' }, 404)
    if (target.company_id !== caller.company_id || target.role !== 'dispatcher') {
      return json({ error: 'You can only edit dispatchers in your own company' }, 403)
    }

    const e164 = toE164(phone)
    if (e164.replace(/\D/g, '').length < 11) {
      return json({ error: 'Invalid phone number' }, 400)
    }

    // Update the auth-login identity first — it carries the uniqueness
    // constraint, so if the new number collides we fail before touching profiles.
    const { error: authUpdateError } = await supabase.auth.admin.updateUserById(staff_id, {
      phone: e164,
      phone_confirm: true,
    })
    if (authUpdateError) {
      const message = authUpdateError.message?.includes('already been registered') || authUpdateError.message?.includes('already exists')
        ? 'That phone number is already in use by another account'
        : (authUpdateError.message ?? 'Failed to update phone number')
      return json({ error: message }, 409)
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ name: name.trim(), phone: e164 })
      .eq('id', staff_id)

    if (profileError) return json({ error: profileError.message }, 500)

    // Log before→after only for fields that actually changed, so the activity
    // log can show "Old Name → New Name" rather than just the current value.
    const newName = name.trim()
    const details: Record<string, unknown> = { staff_id, name: newName }
    if (target.name !== newName) {
      details.name_from = target.name
      details.name_to = newName
    }
    if (target.phone !== e164) {
      details.phone_from = target.phone
      details.phone_to = e164
    }
    const { error: logError } = await supabase.from('dispatch_events').insert({
      company_id: caller.company_id,
      dispatcher_id: callerId,
      event_type: 'staff.updated',
      details,
    })
    if (logError) console.error('dispatch_events log error:', logError)

    console.log(`Dispatcher ${staff_id} updated by admin ${callerId}`)
    return json({ success: true }, 200)
  } catch (error) {
    console.error('update-staff-account error:', error)
    return json({ error: error.message }, 500)
  }
})
