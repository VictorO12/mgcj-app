// Twilio Proxy REST client — the masked-telephony half of G3 Phase 2.
//
// Design: .claude/notes/G3-phase2-masked-telephony-plan.md
//
// Proxy is what makes this weeks-of-work smaller: it owns the number pool, the
// (caller's real number, proxy number) -> session routing, and the rule that one
// participant is never in two live sessions on the same number. We own which
// ride a session belongs to, when it opens and closes, and the audit record.
//
// The trade, stated plainly because it is a standing risk and not a solved one:
// Proxy is PUBLIC BETA and carries NO SLA, underneath a channel we intend to
// sell into a B2B SLA. Availability on this account was verified in the console
// 2026-08-18. If Twilio posts an EOL, §6.3 of the parent design doc is the
// hand-rolled fallback and this module is the seam it swaps at -- which is the
// reason every Proxy concept is confined to this file.
//
// NEVER add call recording here. §6.4: two-party-consent rules vary by
// province, Twilio's own docs tell you to consult counsel, Uber doesn't record,
// and the compliance surface dwarfs the feature. Metadata only.

const TWILIO_SID     = Deno.env.get('TWILIO_ACCOUNT_SID') ?? ''
const TWILIO_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN') ?? ''
const PROXY_SERVICE  = Deno.env.get('TWILIO_PROXY_SERVICE_SID') ?? ''

const PROXY_API = 'https://proxy.twilio.com/v1'

export function proxyConfigured(): boolean {
  return !!(TWILIO_SID && TWILIO_TOKEN && PROXY_SERVICE)
}

/** Names the missing secrets, so a misconfiguration is diagnosable from a log
 *  line rather than by probing. Same reasoning as send-sms's 503. */
export function missingProxyConfig(): string {
  return [
    !TWILIO_SID   && 'TWILIO_ACCOUNT_SID',
    !TWILIO_TOKEN && 'TWILIO_AUTH_TOKEN',
    !PROXY_SERVICE && 'TWILIO_PROXY_SERVICE_SID',
  ].filter(Boolean).join(', ')
}

export class TwilioProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'TwilioProxyError'
  }
}

async function call(path: string, params?: Record<string, string>): Promise<any> {
  const url = `${PROXY_API}${path}`
  const init: RequestInit = {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(params ? { body: new URLSearchParams(params).toString() } : {}),
  }

  const res  = await fetch(url, init)
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }

  if (!res.ok) {
    // Log the Twilio error code verbatim. We deliberately do NOT branch on a
    // specific code for "pool exhausted" -- guessing one from documentation we
    // have not seen fire is how you get a fallback that never triggers. Every
    // allocation failure is treated as fail-closed by the caller (§5: no
    // session means no button means no number to leak), and the code is logged
    // so the real one becomes known from production rather than from a guess.
    throw new TwilioProxyError(
      json?.message ?? text ?? `Twilio Proxy ${res.status}`,
      res.status,
      json?.code ?? null,
    )
  }
  return json
}

export interface ProxyParticipant {
  sid: string
  identifier: string
  /** The number THIS participant dials to reach their partner. Not their caller
   *  ID -- see the two-column note in 20260756_ride_contact_sessions.sql. */
  proxy_identifier: string | null
}

export interface ProxySession {
  sid: string
  unique_name: string | null
  status: string
}

/**
 * Opens a session. Participants are added separately rather than inline,
 * because inline creation reports a pool exhaustion as a session-level failure
 * with no indication of which participant could not be placed -- and knowing
 * that is the difference between "retry" and "fail closed".
 *
 * `uniqueName` must carry no PII (Twilio's constraint). A ride id is a uuid,
 * which satisfies that and makes a session findable from a ride without a
 * lookup table -- but note it must be unique per SESSION, not per ride, and a
 * ride can legitimately have several over its life as drivers cycle. Hence the
 * caller suffixes it.
 */
export async function createSession(
  uniqueName: string,
  opts: { mode?: string; dateExpiry?: string; ttl?: number } = {},
): Promise<ProxySession> {
  const params: Record<string, string> = {
    UniqueName: uniqueName,
    Mode: opts.mode ?? 'voice-and-message',
  }
  if (opts.dateExpiry) params.DateExpiry = opts.dateExpiry
  else if (opts.ttl)   params.Ttl        = String(opts.ttl)

  return await call(`/Services/${PROXY_SERVICE}/Sessions`, params)
}

export async function addParticipant(
  sessionSid: string,
  identifier: string,
  friendlyName: string,
): Promise<ProxyParticipant> {
  return await call(
    `/Services/${PROXY_SERVICE}/Sessions/${sessionSid}/Participants`,
    { Identifier: identifier, FriendlyName: friendlyName },
  )
}

/** Sets when Twilio itself will close the session. This is how the D4 grace
 *  window is enforced for the phone line -- Twilio holds the timer, so there is
 *  no cron of ours to schedule and nothing new that can 401 in silence the way
 *  the four gated jobs did in the 2026-08-15 incident. */
export async function setSessionExpiry(sessionSid: string, dateExpiry: string): Promise<void> {
  await call(`/Services/${PROXY_SERVICE}/Sessions/${sessionSid}`, { DateExpiry: dateExpiry })
}

export async function closeSession(sessionSid: string): Promise<void> {
  await call(`/Services/${PROXY_SERVICE}/Sessions/${sessionSid}`, { Status: 'closed' })
}

/**
 * Sends an SMS INTO an open session, addressed to one participant, appearing to
 * come from the proxy number their partner uses. Replies route back through the
 * session as normal.
 *
 * This is the guest-passenger path from §7 and the strongest single argument
 * for building the telephony half at all: dispatch creates guest profiles for
 * unregistered passengers keyed by phone number, and those people are not on
 * the app, so in-app chat structurally cannot reach them. Masked SMS is the
 * documented degrade, not a hidden button.
 */
export async function sendSessionMessage(
  sessionSid: string,
  participantSid: string,
  body: string,
): Promise<{ sid: string }> {
  return await call(
    `/Services/${PROXY_SERVICE}/Sessions/${sessionSid}/Participants/${participantSid}/MessageInteractions`,
    { Body: body },
  )
}

/**
 * Validates Twilio's X-Twilio-Signature over a webhook request.
 *
 * Non-optional. The callback endpoints must run with verify_jwt = false to be
 * reachable by Twilio at all, and this project has already shipped one function
 * that was open to the internet on exactly that reasoning (send-sms, which
 * carried a comment asserting Supabase validated the caller automatically --
 * it does not, and a POST with no Authorization header reached the body).
 * Without this check, anyone knowing the URL could forge interaction records.
 *
 * The scheme is HMAC-SHA1 over the full URL with the POST body's key/value
 * pairs appended in alphabetical order by key, then base64.
 */
export async function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!signature || !TWILIO_TOKEN) return false

  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TWILIO_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))

  // Constant-time compare, same reasoning as internalAuth's safeEqual.
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}
