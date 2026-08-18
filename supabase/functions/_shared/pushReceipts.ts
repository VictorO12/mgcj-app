// Receipt polling -- the half that actually fixes the phantom-token problem.
//
// A ticket only says Expo accepted the payload. The RECEIPT says what happened
// when Expo handed it to APNs/FCM, and it is the only place a token that was
// valid and then died (uninstall, reinstall, notifications revoked in OS
// settings) reports DeviceNotRegistered. Expo asks for ~15 minutes before
// polling and drops receipts after 24 hours.
//
// Run from scheduled-coverage-monitor's existing 10-minute cron rather than a
// job of its own -- the same piggyback reason as reap_stale_drivers: a new cron
// would add rows to cron.job_run_details, which is what filled the disk once
// already. A 10-minute sweep picks up each ticket within ~10 minutes of it
// becoming eligible, comfortably inside the 24h receipt window.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { retirePushToken } from './push.ts'

const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

// Expo's documented cap for /push/getReceipts.
const EXPO_RECEIPT_BATCH_MAX = 1000

// Expo's recommended wait before a receipt is likely to exist.
const RECEIPT_MIN_AGE_MS = 15 * 60 * 1000

// Receipts are gone after this, so an older row can never be resolved.
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000

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

export interface ReceiptSweepResult {
  polled: number
  retired: number
  swept: number
}

export async function pollPushReceipts(): Promise<ReceiptSweepResult> {
  const now = Date.now()
  const result: ReceiptSweepResult = { polled: 0, retired: 0, swept: 0 }

  // Rows older than the receipt window are unpollable by definition -- drop them
  // rather than carrying them forever. This table gets one row per push SEND and
  // scheduled-release runs every 2 minutes, so retention is not optional.
  const { count: swept, error: sweepErr } = await admin()
    .from('push_tickets')
    .delete({ count: 'exact' })
    .lt('created_at', new Date(now - RECEIPT_MAX_AGE_MS).toISOString())
  if (sweepErr) console.error('[receipts] sweep failed:', JSON.stringify(sweepErr))
  else result.swept = swept ?? 0

  const { data: rows, error } = await admin()
    .from('push_tickets')
    .select('ticket_id, token_sent')
    .lt('created_at', new Date(now - RECEIPT_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(EXPO_RECEIPT_BATCH_MAX)

  if (error) {
    console.error('[receipts] fetch failed:', JSON.stringify(error))
    return result
  }
  if (!rows?.length) return result

  const tokenByTicket = new Map<string, string>(
    rows.map((r) => [r.ticket_id as string, r.token_sent as string]),
  )

  let receipts: Record<string, { status?: string; message?: string; details?: { error?: string } }> = {}
  try {
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: [...tokenByTicket.keys()] }),
    })
    if (!res.ok) {
      // Leave the rows in place; the next sweep retries them.
      console.error(`[receipts] expo ${res.status}: ${await res.text()}`)
      return result
    }
    receipts = (await res.json())?.data ?? {}
  } catch (e) {
    console.error('[receipts] request failed:', e)
    return result
  }

  const deadTokens = new Set<string>()
  const resolved: string[] = []

  for (const [ticketId, receipt] of Object.entries(receipts)) {
    // A receipt that isn't ready yet is simply absent from the response. Only
    // rows we got an answer for are resolved -- the rest stay for the next pass.
    resolved.push(ticketId)
    if (receipt?.status === 'ok') continue

    const code = receipt?.details?.error
    const token = tokenByTicket.get(ticketId)

    // ONLY DeviceNotRegistered may null a token. MismatchSenderId and
    // InvalidCredentials are platform-wide credential failures -- treating them
    // as dead tokens would wipe every push token on the platform in one sweep.
    if (code === 'DeviceNotRegistered') {
      if (token) deadTokens.add(token)
    } else if (code === 'MismatchSenderId' || code === 'InvalidCredentials') {
      console.error(
        `[receipts] CREDENTIAL FAILURE (${code}) — nobody on the platform is receiving pushes. ${receipt?.message ?? ''}`,
      )
    } else {
      console.warn(`[receipts] ${code ?? 'unknown'}: ${receipt?.message ?? ''}`)
    }
  }

  for (const token of deadTokens) {
    await retirePushToken(token)
    result.retired++
  }

  if (resolved.length) {
    const { error: delErr } = await admin()
      .from('push_tickets')
      .delete()
      .in('ticket_id', resolved)
    if (delErr) console.error('[receipts] cleanup failed:', JSON.stringify(delErr))
  }

  result.polled = resolved.length
  console.log(
    `[receipts] polled ${result.polled}, retired ${result.retired}, swept ${result.swept} expired`,
  )
  return result
}
