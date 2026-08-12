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

// SMS is billed per segment, and the segment size depends on the alphabet: a
// message that fits GSM-7 gets 160 chars, but ONE character outside that set
// re-encodes the whole message as UCS-2 at 70. Message bodies now interpolate
// tenant-controlled text (the company name), so a smart apostrophe pasted into
// "CJ's Taxi Ltd" would silently double the cost of every reminder.
//
// Only typographic punctuation is normalised — characters that carry no
// meaning and are almost always an accident of where the text was typed.
// Accented letters are deliberately left alone: mangling a company's actual
// name to save a segment is the wrong trade, and é/à/ò are in GSM-7 anyway.
const PUNCTUATION_TO_ASCII: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-',
  '\u2015': '-', '\u2212': '-', '\u00B7': '-', '\u2022': '-',
  '\u2026': '...',
  '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u200B': '',
}

// The GSM-7 alphabet. Extension characters (^{}[]~|\\ and the euro sign) cost
// two septets each but don't force UCS-2, so they belong in the set.
const GSM7 =
  /^[@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5_\u00C6\u00E6\u00DF\u00C9 !"#\u00A4%&'()*+,\-./0-9:;<=>?\u00A1A-Z\u00C4\u00D6\u00D1\u00DC\u00A7\u00BFa-z\u00E4\u00F6\u00F1\u00FC\u00E0\f^{}\\[~\]|\u20AC]*$/

function normaliseForSms(message: string): string {
  const cleaned = message.replace(
    /[\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u2010-\u2015\u2212\u00B7\u2022\u2026\u00A0\u2007\u202F\u200B]/g,
    (c) => PUNCTUATION_TO_ASCII[c] ?? c,
  )
  if (!GSM7.test(cleaned)) {
    // Not an error — a genuinely accented name is worth the extra segment —
    // but it doubles the per-message cost, so make it visible in the logs.
    const offenders = [...new Set(cleaned.split('').filter((c) => !GSM7.test(c)))]
    console.warn(
      `[send-sms] message is UCS-2 (70-char segments) because of: ${offenders.join(' ')}`,
    )
  }
  return cleaned
}

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
      Body: normaliseForSms(message),
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