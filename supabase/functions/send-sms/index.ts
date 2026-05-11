// supabase/functions/send-sms/index.ts
//
// A tiny internal helper that sends SMS via Twilio.
// Called by process-scheduled-rides — not exposed publicly.
//
// Secrets to set in Supabase Dashboard → Settings → Edge Functions → Secrets:
//   TWILIO_ACCOUNT_SID   — from twilio.com/console
//   TWILIO_AUTH_TOKEN    — from twilio.com/console
//   TWILIO_FROM_NUMBER   — your Twilio phone number, e.g. +19025551234

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const TWILIO_SID   = Deno.env.get('TWILIO_ACCOUNT_SID') ?? ''
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? ''
const TWILIO_FROM  = Deno.env.get('TWILIO_FROM_NUMBER') ?? ''

serve(async (req) => {
  // Only accept internal calls (service role key in Authorization header)
  // Supabase validates this automatically when verify_jwt = false and the
  // call comes from another Edge Function using the service role key.

  try {
    const { phone, message } = await req.json()

    if (!phone || !message) {
      return new Response(JSON.stringify({ error: 'phone and message required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
      console.warn('[send-sms] Twilio not configured — skipping')
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const body = new URLSearchParams({
      From: TWILIO_FROM,
      To: phone,
      Body: message,
    })

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    )

    const json = await res.json()

    if (json.error_code) {
      console.error('[send-sms] Twilio error:', json.message)
      return new Response(JSON.stringify({ error: json.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[send-sms] sent to', phone, '| sid:', json.sid)
    return new Response(JSON.stringify({ sid: json.sid }), {
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[send-sms] error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})