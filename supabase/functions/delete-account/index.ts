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

    // Verify the caller's identity via their JWT
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

    // Only passengers can self-delete
    const { data: profile } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'passenger') {
      return new Response(JSON.stringify({ error: 'Only passenger accounts can be deleted' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Use service role for privileged operations
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Null out passenger_id on rides and reviews — keeps records intact
    //    but detaches them from this account
    await adminClient
      .from('rides')
      .update({ passenger_id: null })
      .eq('passenger_id', user.id)

    await adminClient
      .from('ride_reviews')
      .update({ passenger_id: null })
      .eq('passenger_id', user.id)

    // 2. Explicitly delete the profile row — don't rely on cascade
    const { error: profileDeleteError } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', user.id)

    if (profileDeleteError) {
      console.error('Profile delete error:', profileDeleteError)
      return new Response(JSON.stringify({ error: profileDeleteError.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    // 3. Delete the auth user — phone number is now fully released
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id)

    if (deleteError) {
      console.error('Auth delete error:', deleteError)
      return new Response(JSON.stringify({ error: deleteError.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Account fully deleted: ${user.id}`)
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