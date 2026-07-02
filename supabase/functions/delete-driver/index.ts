import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Only admins may delete drivers
    const { data: callerProfile } = await userClient
      .from('profiles')
      .select('role, company_id')
      .eq('id', user.id)
      .single()

    if (callerProfile?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { driver_id } = await req.json()
    if (!driver_id) {
      return new Response(JSON.stringify({ error: 'driver_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Verify the driver belongs to the same company
    const { data: driverProfile } = await adminClient
      .from('profiles')
      .select('company_id, role')
      .eq('id', driver_id)
      .single()

    if (!driverProfile || driverProfile.role !== 'driver') {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    if (driverProfile.company_id !== callerProfile.company_id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Soft-delete: stamp deleted_at and deactivate the account
    const { error: updateError } = await adminClient
      .from('profiles')
      .update({ deleted_at: new Date().toISOString(), is_active: false, deactivation_pending: false })
      .eq('id', driver_id)

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Ban the auth user so they can no longer sign in or refresh tokens
    const { error: banError } = await adminClient.auth.admin.updateUserById(driver_id, {
      ban_duration: '87660h', // ~10 years
    })

    if (banError) {
      console.error('Ban user error:', banError)
      // Non-fatal — profile is already soft-deleted
    }

    console.log(`Driver soft-deleted: ${driver_id} by admin ${user.id}`)
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
})
