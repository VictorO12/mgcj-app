// Single source of truth for sending Expo pushes -- the fare.ts / presence.ts
// pattern. Before this there were 9 hand-rolled copies of sendPush across 17
// call sites, and 8 of them did `await fetch(...)` without ever reading the
// response body, so every delivery failure was discarded.
//
// Sending is TWO phases:
//   1. TICKET  -- returned synchronously by /push/send. Only means "Expo accepted
//                 the payload". Max 100 messages per request.
//   2. RECEIPT -- fetched later via /push/getReceipts. Means "Expo handed it to
//                 APNs/FCM, and here is what happened". Kept 24h; Expo asks for a
//                 ~15 minute wait before polling.
//
// DeviceNotRegistered arrives in BOTH, and the split is the whole point: a token
// that was invalid UPFRONT reports it in the ticket, but a token that was valid
// and then DIED -- uninstall, reinstall, or notifications revoked in OS settings
// -- reports it only in the RECEIPT. Handling tickets alone does not fix the
// phantom-token problem. See .claude/notes/push-receipts-devicenotregistered.md.
//
// So: ticket errors are retired here, immediately; ticket ids for accepted
// messages are parked in push_tickets for the poller to follow up on.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Expo's documented per-request cap for /push/send.
export const EXPO_SEND_BATCH_MAX = 100

export interface PushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  sound?: 'default' | null
  priority?: 'high' | 'normal'
  /**
   * NOTE: assign-ride sends `categoryIdentifier` (not `categoryId`) and that is
   * what drives the driver's Accept/Decline action buttons on the ride offer.
   * Both are declared and passed through verbatim — do not "normalise" them to
   * one field without testing the offer buttons on a real device.
   */
  categoryId?: string
  categoryIdentifier?: string
  channelId?: string
  /** Seconds Expo should keep trying. assign-ride uses 90 — a ride offer is dead after that. */
  ttl?: number
  /** Anything else Expo accepts, passed through untouched. */
  [key: string]: unknown
}

export interface PushResult {
  /** The message was accepted by Expo. NOT proof of delivery -- that's the receipt. */
  ok: boolean
  /** Present when ok: the id to poll for a receipt later. */
  ticketId?: string
  /** Expo's error code when not ok, e.g. 'DeviceNotRegistered'. */
  error?: string
  /** Human-readable message from Expo, for logs. */
  message?: string
}

let cached: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
  }
  return cached
}

/**
 * Retire a token we now know is dead. Matches on the token VALUE, never a user
 * id -- see the retire_push_token comment in 20260753 for the replaced-phone
 * race that makes the distinction load-bearing.
 */
export async function retirePushToken(token: string): Promise<void> {
  try {
    const { error } = await admin().rpc('retire_push_token', { p_token: token })
    if (error) console.error('[push] retire_push_token failed:', JSON.stringify(error))
    else console.log(`[push] retired dead token …${token.slice(-8)}`)
  } catch (e) {
    console.error('[push] retire_push_token threw:', e)
  }
}

/**
 * Send one push. Returns a result rather than throwing -- a dead token is an
 * expected outcome here, not an exception.
 */
export async function sendPush(
  token: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  opts: Partial<Omit<PushMessage, 'to' | 'title' | 'body' | 'data'>> = {},
): Promise<PushResult> {
  if (!token) return { ok: false, error: 'NoToken' }
  const [result] = await sendPushMany([
    { to: token, title, body, data, sound: 'default', priority: 'high', ...opts },
  ])
  return result
}

/**
 * Send many pushes, chunked to Expo's 100-per-request cap.
 * Results are returned in the same order as `messages`.
 */
export async function sendPushMany(messages: PushMessage[]): Promise<PushResult[]> {
  const results: PushResult[] = new Array(messages.length)

  for (let start = 0; start < messages.length; start += EXPO_SEND_BATCH_MAX) {
    const chunk = messages.slice(start, start + EXPO_SEND_BATCH_MAX)

    let tickets: Array<{ status?: string; id?: string; message?: string; details?: { error?: string } }> = []
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk.map((m) => ({
          sound: 'default',
          priority: 'high',
          ...m,
        }))),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[push] expo ${res.status}: ${text}`)
        for (let i = 0; i < chunk.length; i++) {
          results[start + i] = { ok: false, error: 'HttpError', message: `${res.status}` }
        }
        continue
      }
      const json = await res.json()
      tickets = json?.data ?? []
    } catch (e) {
      console.error('[push] send failed:', e)
      for (let i = 0; i < chunk.length; i++) {
        results[start + i] = { ok: false, error: 'NetworkError', message: String(e) }
      }
      continue
    }

    const toPark: { ticket_id: string; token_sent: string }[] = []
    const deadTokens = new Set<string>()

    for (let i = 0; i < chunk.length; i++) {
      const ticket = tickets[i]
      // A missing ticket is treated as failure, not success: the response was
      // short or malformed and we have nothing to poll a receipt with.
      if (!ticket || ticket.status !== 'ok') {
        const code = ticket?.details?.error
        results[start + i] = { ok: false, error: code ?? 'NoTicket', message: ticket?.message }
        // Invalid-upfront tokens report here. The revoked/reinstalled cases do
        // not -- those only surface in the receipt, which is the poller's job.
        if (code === 'DeviceNotRegistered') deadTokens.add(chunk[i].to)
        continue
      }
      results[start + i] = { ok: true, ticketId: ticket.id }
      if (ticket.id) toPark.push({ ticket_id: ticket.id, token_sent: chunk[i].to })
    }

    if (toPark.length) {
      // Never let bookkeeping fail a send that already went out.
      const { error } = await admin()
        .from('push_tickets')
        .upsert(toPark, { onConflict: 'ticket_id', ignoreDuplicates: true })
      if (error) console.error('[push] parking tickets failed:', JSON.stringify(error))
    }

    for (const token of deadTokens) await retirePushToken(token)
  }

  return results
}
