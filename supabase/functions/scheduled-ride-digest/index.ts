// Tells a driver that scheduled work they can claim has appeared on the
// Available board — once per ride, per time that ride becomes available.
//
// That distinction is deliberate, not a loophole. A ride is announced to a
// given driver exactly once while it sits open, no matter how long it sits.
// But if it leaves the pool and RE-ENTERS it (someone claims and releases it,
// dispatch clears a preference, a driver hands it back), became_open_at is
// re-stamped and it is announceable again — including to a driver who heard
// about it the first time round. That is the point of the column: the ride
// genuinely is available again, and the alternative is work silently
// re-entering the pool with nobody told.
//
// ── Why there is no time of day in this function ────────────────────────────
// The first cut of this fired once daily at 6pm and reported "what's open for
// tomorrow". Both halves were wrong for the customers this is built for: taxi
// companies run 24 hours, so there is no company-wide evening, and "tomorrow"
// is meaningless at 2am to a driver whose shift starts at 8pm. Any clock
// constant is wrong for somebody. So the trigger is CONTENT — new claimable
// work appeared — and the only timing rule is a per-driver rate ceiling.
//
// Quiet hours are deliberately NOT implemented. iOS Focus and Android DND
// already solve this per-person, already configured by the driver, and they
// correctly handle a night driver's quiet hours being the inverse of a day
// driver's. Any range hardcoded here is wrong for half a 24h fleet.
//
// ── Why the ceiling gets LONGER as a fleet gets bigger ──────────────────────
// Counterintuitive but load-bearing: at thousands of rides a day the board is
// never empty, so "new work exists" carries almost no information — the driver
// already knows. Push value is inversely proportional to supply. The watermark
// gives one mechanism that is correct at both ends: a small fleet naturally
// produces few pushes because little new work appears, and a large fleet gets
// clamped by the ceiling. Do not "fix" this by shortening the interval for big
// customers.
//
// ── The seam ───────────────────────────────────────────────────────────────
// "Is there new work" and "should this driver be pushed right now" are separate
// questions, and the second lives entirely in shouldSendDigest(). The cron is
// dumb and frequent. Future work — driver-set frequency, holding a push until
// the driver isn't mid-ride, learned per-driver windows — is a change inside
// that one predicate, not a rewrite of this pipeline. Presence-aware timing
// specifically is blocked until the last_seen_at heartbeat build is universal;
// today every online driver still reports NULL.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL  = 'https://exp.host/--/api/v2/push/send'
const EXPO_BATCH_MAX = 100          // Expo's documented per-request message cap
const TZ             = 'America/Halifax'

// Rides nearer than this are scheduled-release's problem, not the digest's: it
// starts releasing at most 75 minutes before pickup. The margin keeps the two
// from ever racing over the same ride.
const RELEASE_SAFETY_MINS = 90

// How far ahead work is announceable. Bounds the message, not the trigger —
// the watermark already guarantees each ride is announced at most once.
const HORIZON_HOURS = 72

// ── The two-tier ceiling ────────────────────────────────────────────────────
// A single floor has a real failure: a ride booked at noon for 6pm tonight gets
// held by a 6-hour ceiling and released to the pool before any driver hears it
// exists. So the ceiling is set by how fast the claim window is CLOSING.
//
// URGENT_HOURS is a proxy for "the claim window is closing soon", not a
// meaningful quantity in itself — the real one is time-to-release-threshold,
// which is computed per-ride and dynamic (10-75 min before pickup). Don't treat
// 12 as load-bearing; it's a cheap stand-in.
const URGENT_HOURS      = 12
const FLOOR_NORMAL_MS   = 6 * 60 * 60 * 1000
const FLOOR_URGENT_MS   = 1 * 60 * 60 * 1000

interface OpenRide {
  id: string
  company_id: string
  vehicle_class_id: string | null
  scheduled_at: string
  became_open_at: string | null
}

interface DriverRow {
  id: string
  push_token: string | null
  vehicle_class_id: string | null
  digest_watermark_at: string | null
  digest_last_sent_at: string | null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

// Mirror claim-scheduled-ride's rule exactly: a null class on either side means
// "any". Counting a ride this driver would be REJECTED for is worse than saying
// nothing — a push promising work that yields nothing claimable is how the
// channel gets muted.
function classMatches(ride: OpenRide, driver: DriverRow): boolean {
  if (!ride.vehicle_class_id) return true
  if (driver.vehicle_class_id === null) return true
  return driver.vehicle_class_id === ride.vehicle_class_id
}

// ── The seam: everything about WHEN lives here ──────────────────────────────
function shouldSendDigest(
  driver: DriverRow,
  newRides: OpenRide[],
  now: Date,
): { send: boolean; reason: string } {
  if (newRides.length === 0) return { send: false, reason: 'nothing new' }

  const urgent = newRides.some(
    (r) => new Date(r.scheduled_at).getTime() - now.getTime() <= URGENT_HOURS * 3_600_000
  )
  const floor = urgent ? FLOOR_URGENT_MS : FLOOR_NORMAL_MS

  if (driver.digest_last_sent_at) {
    const since = now.getTime() - new Date(driver.digest_last_sent_at).getTime()
    if (since < floor) {
      // Held, not dropped: the watermark is untouched, so these rides are still
      // pending for this driver and the next tick past the floor picks them up.
      return { send: false, reason: `rate-limited (${Math.round(since / 60000)}m of ${floor / 60000}m)` }
    }
  }
  return { send: true, reason: urgent ? 'urgent' : 'normal' }
}

Deno.serve(async () => {
  try {
    const now        = new Date()
    const windowFrom = new Date(now.getTime() + RELEASE_SAFETY_MINS * 60_000)
    const windowTo   = new Date(now.getTime() + HORIZON_HOURS * 3_600_000)

    // Same predicates as the board's fetchOpenRides. A ride dispatch has
    // expressed a preference on is not open work, even with driver_id null.
    const { data: openRides, error: ridesErr } = await supabase
      .from('rides')
      .select('id, company_id, vehicle_class_id, scheduled_at, became_open_at')
      .eq('status', 'scheduled')
      .is('driver_id', null)
      .is('preferred_driver_id', null)
      .gte('scheduled_at', windowFrom.toISOString())
      .lte('scheduled_at', windowTo.toISOString())
      .order('scheduled_at', { ascending: true })

    if (ridesErr) return json({ error: ridesErr.message }, 500)

    const byCompany = new Map<string, OpenRide[]>()
    for (const r of (openRides ?? []) as OpenRide[]) {
      if (!r.company_id) continue
      const list = byCompany.get(r.company_id) ?? []
      list.push(r)
      byCompany.set(r.company_id, list)
    }

    // A driver whose company has no open work still needs evaluating: a brand
    // new driver must get their watermark seeded, or their first ever digest
    // arrives as a backlog dump. Hence querying drivers by company, not only
    // the companies that happen to have rides right now.
    const { data: allDrivers, error: drvErr } = await supabase
      .from('drivers')
      .select('id, company_id, push_token, vehicle_class_id, digest_watermark_at, digest_last_sent_at')
      .not('push_token', 'is', null)

    if (drvErr) return json({ error: drvErr.message }, 500)

    const messages: Record<string, unknown>[] = []
    // Parallel to `messages`: what to write back if Expo accepts message i.
    const pending: { driverId: string; watermark: string }[] = []
    const seeded: string[] = []
    let heldByRate = 0

    for (const driver of (allDrivers ?? []) as (DriverRow & { company_id: string })[]) {
      const companyRides = byCompany.get(driver.company_id) ?? []
      const mine = companyRides.filter((r) => classMatches(r, driver) && r.became_open_at)

      // NOTE — the audience filter is a push_token and nothing else. This is the
      // one driver-read site that must NOT use isDriverDispatchable(): that
      // means "reachable and online RIGHT NOW", which is the right question for
      // a 30-second ride offer and the wrong one for a message about work days
      // out. Filtering on is_active would reach only drivers on shift at send
      // time — precisely the ones not sitting down to plan.

      if (driver.digest_watermark_at === null) {
        // First ever evaluation. Seed at now() and send NOTHING: a new or
        // reinstalled driver's first push must not be the entire standing
        // backlog, which is the single push most likely to get the channel
        // muted for good. The cost is explicit — work already open when they
        // joined is never pushed to them, only ever seen on the board. Seeding
        // from the horizon-filtered set instead would be worse and subtler: a
        // ride 5 days out isn't in `mine`, so it would sit below the watermark
        // by the time it entered the horizon and never be announced at all.
        await supabase
          .from('drivers')
          .update({ digest_watermark_at: now.toISOString() })
          .eq('id', driver.id)
        seeded.push(driver.id)
        continue
      }

      const watermark = driver.digest_watermark_at
      const fresh = mine.filter((r) => r.became_open_at! > watermark)

      const { send, reason } = shouldSendDigest(driver, fresh, now)
      if (!send) {
        if (reason.startsWith('rate-limited')) heldByRate++
        continue
      }

      const soonest = fresh.reduce((a, b) =>
        new Date(a.scheduled_at) <= new Date(b.scheduled_at) ? a : b
      )
      const when = new Date(soonest.scheduled_at).toLocaleString('en-US', {
        weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ,
      })
      const n = fresh.length

      messages.push({
        to: driver.push_token,
        title: '🗓 New rides you can claim',
        // Deliberately the NEW count, never the running total. Restating work
        // they've already been told about reintroduces the repetition the
        // watermark exists to prevent, just through the message body instead of
        // the trigger. The running total belongs on the board.
        body:
          `${n} new scheduled ${n === 1 ? 'ride' : 'rides'} open — ` +
          `earliest ${when}. Tap to claim.`,
        data: { type: 'available_rides_digest', companyId: driver.company_id, count: n },
        sound: 'default',
        priority: 'normal', // not time-critical, unlike a ride offer
      })
      pending.push({
        driverId: driver.id,
        // Highest became_open_at actually announced. Advancing past rides that
        // weren't in this message would silence them forever.
        watermark: fresh.reduce<string>(
          (max, r) => (r.became_open_at! > max ? r.became_open_at! : max),
          watermark
        ),
      })
    }

    // ── Send, and only advance the watermark for messages Expo ACCEPTED ──────
    // If the watermark moved on a push that died (a stale token yields a
    // DeviceNotRegistered ticket), that driver would never hear about those
    // rides again — the watermark has passed them. Per-ticket write-back makes
    // a failed send a retry on the next tick instead of a silent hole. Nulling
    // dead tokens still belongs to the open push-receipts work, not here.
    let sent = 0, rejected = 0
    for (let i = 0; i < messages.length; i += EXPO_BATCH_MAX) {
      const chunk     = messages.slice(i, i + EXPO_BATCH_MAX)
      const chunkMeta = pending.slice(i, i + EXPO_BATCH_MAX)
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(chunk),
        })
        if (!res.ok) {
          console.error(`[digest] expo ${res.status}: ${await res.text()}`)
          continue
        }
        const body = await res.json()
        const tickets: { status?: string; message?: string }[] = body?.data ?? []

        for (let j = 0; j < chunkMeta.length; j++) {
          // No ticket at all (malformed/short response) is treated as failure —
          // holding the watermark costs one duplicate at worst; advancing it
          // wrongly costs the ride forever.
          if (tickets[j]?.status !== 'ok') {
            rejected++
            console.warn(`[digest] driver ${chunkMeta[j].driverId.slice(0, 8)} ticket: ${tickets[j]?.message ?? 'missing'}`)
            continue
          }
          await supabase
            .from('drivers')
            .update({
              digest_watermark_at: chunkMeta[j].watermark,
              digest_last_sent_at: now.toISOString(),
            })
            .eq('id', chunkMeta[j].driverId)
          sent++
        }
      } catch (e) {
        console.error('[digest] expo send failed', e)
      }
    }

    const summary = {
      sent,
      rejected,
      seeded: seeded.length,
      held_by_rate_limit: heldByRate,
      open_rides_in_horizon: openRides?.length ?? 0,
      companies: byCompany.size,
    }
    console.log('[digest]', JSON.stringify(summary))
    return json(summary)
  } catch (error) {
    console.error('scheduled-ride-digest error:', error)
    return json({ error: String((error as Error).message ?? error) }, 500)
  }
})
