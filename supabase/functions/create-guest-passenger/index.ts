// Dispatch's "book a ride for someone who has no account" — moved server-side.
//
// This was inline in mgcj-dashboard's createManualBooking(), and the way it
// worked was the problem: to satisfy the profiles RLS WITH CHECK (which only
// lets a session insert its OWN profile row), the dashboard saved the
// dispatcher's access/refresh tokens into two local variables, called
// signInAnonymously() in the dispatcher's own browser tab, inserted the guest
// row as that anonymous user, then restored the dispatcher's session from the
// saved tokens.
//
// Two things wrong with that. If anything interrupted the window — a dropped
// request on the insert, a refresh, a closed tab — the dispatcher was left
// sitting in an anonymous session inside the dispatch console. And `supabase`
// is a module singleton, so ANY other in-flight query in that tab during the
// window executed as the anonymous guest rather than as the dispatcher.
//
// The session swap only ever existed to get around RLS. Dispatch creating a
// passenger record is a legitimate dispatch action; it belongs in a service-role
// function, the same way assignDriver() became dispatch-assign-ride.
//
// The guest auth user deliberately carries NO phone number. auth.users.phone is
// unique, so a phone-bearing guest user would be the very user signInWithOtp()
// returns when that passenger later signs up — they would log into the guest
// account and inherit all of its ride history, which is precisely the merge
// behaviour that was removed in 20260757. Keeping it credential-less means
// signup mints a separate real user, and claim_guest_rides() moves only the
// rides that are still happening.
//
// Browser-called, so it handles the CORS preflight and is deployed with
// verify_jwt = false (see config.toml): the preflight OPTIONS carries no
// Authorization header, so gateway JWT verification 401s it before this code
// runs and the browser reports it as a missing CORS header rather than as an
// auth failure. The caller's JWT and dispatch role are verified below.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

const supabase = createClient(
  SUPABASE_URL,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? raw : `+${digits}`
}

// Existing passenger on this number, guest or real. Service role, so this sees
// rows the dispatcher's own session cannot.
async function findPassenger(phone: string) {
  const { data } = await supabase
    .from('profiles')
    .select('id, name, is_guest')
    .eq('phone', phone)
    // Null-tolerant: profiles_role_check is a CHECK and NULL satisfies a CHECK,
    // so a role-less row from before that constraint is possible. Drivers and
    // admins are excluded — they reach signup by a different path, and booking
    // one as the passenger is the bug this filter prevents.
    .or('role.eq.passenger,role.is.null')
    .maybeSingle()
  return data ?? null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) return json({ error: 'Unauthorized' }, 401)

    const { data: actor } = await supabase
      .from('profiles')
      .select('id, role, company_id')
      .eq('id', userData.user.id)
      .maybeSingle()

    if (!actor || (actor.role !== 'admin' && actor.role !== 'dispatcher')) {
      return json({ error: 'Dispatch only' }, 403)
    }

    const body = await req.json()
    const rawPhone: string = body?.phone ?? ''
    const rawName: string = body?.name ?? ''
    if (!rawPhone) return json({ error: 'phone required' }, 400)

    const phone = toE164(rawPhone)
    if (phone.replace(/\D/g, '').length < 11) {
      return json({ error: 'Invalid phone number' }, 400)
    }
    const name = rawName.trim() || 'Guest'

    // Authoritative existence check. The dashboard checks too, but two
    // dispatchers booking the same new number at once could both pass a
    // client-side check; this one runs with the service role and is the last
    // word before we mint anything.
    const existing = await findPassenger(phone)
    if (existing) {
      return json({ id: existing.id, name: existing.name, created: false, is_guest: existing.is_guest })
    }

    // No admin API creates a credential-less user, and admin.createUser()
    // requires an email or a phone — a phone here would be actively harmful
    // (see header) and an email would be fabricated. Anonymous sign-in is the
    // one path that yields an auth.users row with neither. The session it
    // returns is discarded; we only want the user id.
    // Named explicitly rather than `!`-asserted: if this is ever absent the
    // failure should say so, not surface as an opaque auth error. Cf. the
    // 2026-08-15 incident where a platform-injected key was assumed to be
    // something it wasn't and four crons 401'd silently for weeks.
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!anonKey) {
      return json({ error: 'SUPABASE_ANON_KEY is not set in this function\'s environment' }, 503)
    }
    const anonClient = createClient(SUPABASE_URL, anonKey)
    const { data: anonData, error: anonError } = await anonClient.auth.signInAnonymously()
    if (anonError || !anonData?.user) {
      return json({ error: `Could not create guest account: ${anonError?.message ?? 'unknown error'}` }, 500)
    }
    const guestId = anonData.user.id

    // Upsert, not insert: on_auth_user_created has already created a bare
    // profiles row for this user (phone NULL since 20260760).
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .upsert(
        { id: guestId, phone, name, role: 'passenger', is_guest: true },
        { onConflict: 'id' },
      )
      .select('id, name, is_guest')
      .single()

    if (profileError) {
      // 23505 here is profiles_phone_key — a concurrent booking for the same
      // number won the race between our existence check and this write. Their
      // guest row is as good as ours, so drop the auth user we just minted
      // (profiles_id_fkey cascades the bare row with it) and return theirs.
      if (profileError.code === '23505') {
        await supabase.auth.admin.deleteUser(guestId)
        const winner = await findPassenger(phone)
        if (winner) {
          return json({ id: winner.id, name: winner.name, created: false, is_guest: winner.is_guest })
        }
      }
      await supabase.auth.admin.deleteUser(guestId)
      return json({ error: `Could not create guest profile: ${profileError.message}` }, 500)
    }

    return json({ id: profile.id, name: profile.name, created: true, is_guest: profile.is_guest })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
