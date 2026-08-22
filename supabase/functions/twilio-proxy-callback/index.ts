// G3 Phase 2 — Twilio's webhooks for the masked line.
//
// Wired to TWO fields on the Proxy Service:
//   callback_url                 interaction status changes (a call or text
//                                passed through the session)
//   out_of_session_callback_url  someone dialled or texted a proxy number whose
//                                session is closed or never existed
//
// ── Authentication is not optional here ────────────────────────────────────
// This must run with verify_jwt = false to be reachable by Twilio at all, and
// this project has already shipped one function that was open to the internet
// on precisely that reasoning: send-sms carried a comment asserting Supabase
// validated the caller automatically when verify_jwt = false. It does not — a
// POST with no Authorization header at all reached the body (verified live
// 2026-08-15) and could send SMS on the project's Twilio account.
//
// So every request is checked against X-Twilio-Signature, and an unsigned
// request gets nothing — not even the out-of-session courtesy reply, which
// would otherwise be a free SMS-send primitive for anyone with the URL.
//
// ── No recording, ever ─────────────────────────────────────────────────────
// §6.4. Metadata only: which session, when, and how many interactions. Nothing
// in this file may grow into transcription or recording.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { validateTwilioSignature } from '../_shared/twilioProxy.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const XML = { 'Content-Type': 'text/xml' }

/** Twilio's signature is computed over the URL it was configured with. Behind
 *  Supabase's gateway `req.url` is what Twilio called, so it matches — but if
 *  the function is ever fronted by another host, set TWILIO_WEBHOOK_URL to the
 *  externally-visible URL or every request will fail validation. */
function callbackUrl(req: Request): string {
  return Deno.env.get('TWILIO_WEBHOOK_URL') || req.url
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const valid = await validateTwilioSignature(
    req.headers.get('X-Twilio-Signature'),
    callbackUrl(req),
    params,
  )
  if (!valid) {
    console.warn('[twilio-proxy-callback] rejected: bad or missing X-Twilio-Signature')
    return new Response('Forbidden', { status: 403 })
  }

  try {
    const sessionSid = params.sessionSid ?? params.SessionSid ?? null
    const isVoice    = !!(params.CallSid ?? params.callSid)
    const isSms      = !!(params.MessageSid ?? params.messageSid ?? params.Body)

    // ── Out of session ────────────────────────────────────────────────────
    // The line for this ride has closed — either the 2h grace elapsed or the
    // ride ended. Answer, rather than letting it ring out or bounce: the
    // commonest caller here is a passenger who found a bag missing three hours
    // after a ride, and silence sends them nowhere. Point them at dispatch,
    // which is the correct escalation and, per §7, the only one that never
    // reveals a real number.
    if (!sessionSid) {
      if (isSms) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Message>` +
          `This number is only active during a ride and that ride has ended. ` +
          `Please contact dispatch for help.` +
          `</Message></Response>`,
          { headers: XML },
        )
      }
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Say voice="alice">This number is only active during a ride, and that ride has ended. ` +
        `Please contact dispatch for help. Goodbye.</Say><Hangup/></Response>`,
        { headers: XML },
      )
    }

    // ── In-session interaction ────────────────────────────────────────────
    const { data: row } = await supabase
      .from('ride_contact_sessions')
      .select('id, ride_id, voice_interactions, sms_interactions')
      .eq('proxy_session_sid', sessionSid)
      .maybeSingle()

    if (!row) {
      // A session Twilio knows about and we do not. Worth seeing: it means an
      // allocation wrote to Twilio and failed to write to us, which is the one
      // orphan sync-ride-contact tries hard to prevent.
      console.warn(`[twilio-proxy-callback] unknown session ${sessionSid}`)
      return new Response('ok', { status: 200 })
    }

    await supabase
      .from('ride_contact_sessions')
      .update({
        voice_interactions:  row.voice_interactions + (isVoice ? 1 : 0),
        sms_interactions:    row.sms_interactions   + (isSms   ? 1 : 0),
        last_interaction_at: new Date().toISOString(),
      })
      .eq('id', row.id)

    // Metadata only — never the message body, never a recording URL.
    console.log(
      `[twilio-proxy-callback] ride ${row.ride_id} | session ${sessionSid} | ` +
      `${isVoice ? 'voice' : isSms ? 'sms' : 'other'} | status ${params.status ?? params.InteractionStatus ?? '?'}`,
    )

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error('[twilio-proxy-callback] error:', err)
    return new Response('ok', { status: 200 })
  }
})
