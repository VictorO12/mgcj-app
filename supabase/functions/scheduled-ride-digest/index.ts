// Daily "here's tomorrow's open work" digest for drivers.
//
// This is the push half of the soft-claim Available board. The in-app half
// already works (the board is live via realtime), but a driver only sees it if
// they happen to open the app — so rides sat unclaimed until scheduled-release
// pushed them out at T-75-to-10, which is far too late to plan a day around.
//
// Deliberately NOT a per-ride broadcast on booking. A push per scheduled ride to
// every driver competes with the ride-offer channel that immediate dispatch
// depends on: offers are time-critical and get 30s to be answered, and training
// drivers to swipe away taxi notifications is how you lose those. One push a
// day, only to drivers who actually have claimable work, is the whole design.
//
// STATELESS BY DESIGN: this reports what is *open right now*, not what is *new
// since last run*. "New since" needs a watermark column and another hand-applied
// migration; "open now" is just the board's own query run server-side. A ride
// still open two days running gets counted twice — that's correct, it IS still
// open.
//
// Scope boundary with scheduled-release: the digest covers TOMORROW only (a full
// Halifax calendar day), which sits entirely outside release's 75-minute
// horizon. The two can't double-notify about the same ride, and there's no gap
// where a ride is too far out for release but too near for the digest.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_BATCH_MAX = 100        // Expo's documented per-request message cap
const TZ = 'America/Halifax'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

// ── Halifax calendar-day boundaries ─────────────────────────────────────────
// The cron fires on a UTC schedule, so the wall-clock time it lands drifts an
// hour across DST. That's fine for "tomorrow's work" — but the WINDOW must not
// drift, or on one changeover day the digest would silently include or exclude
// an hour of real rides. Hence resolving true Halifax midnight rather than
// doing arithmetic on UTC offsets.
function tzOffsetMs(d: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map((p) => [p.type, p.value])
  ) as Record<string, string>
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  )
  return asUTC - d.getTime()
}

// Instant of 00:00 Halifax on the local calendar date `daysAhead` days from now.
// Two passes because the offset that applies at local midnight can differ from
// the offset right now (DST changeover night).
function halifaxMidnight(daysAhead: number, now: Date): Date {
  const target = new Date(now.getTime() + daysAhead * 86_400_000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(target).map((p) => [p.type, p.value])
  ) as Record<string, string>
  const naive = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 0, 0, 0)

  let guess = new Date(naive)
  for (let i = 0; i < 2; i++) guess = new Date(naive - tzOffsetMs(guess))
  return guess
}

interface OpenRide {
  id: string
  company_id: string
  vehicle_class_id: string | null
  scheduled_at: string
}

Deno.serve(async () => {
  try {
    const now = new Date()
    const windowStart = halifaxMidnight(1, now)   // tomorrow 00:00 Halifax
    const windowEnd   = halifaxMidnight(2, now)   // day after 00:00 Halifax

    // Same predicates as the board's fetchOpenRides: unassigned, unclaimed and
    // with no dispatch preference. A ride dispatch has expressed intent on is
    // not open work, even though driver_id is still null.
    const { data: openRides, error: ridesErr } = await supabase
      .from('rides')
      .select('id, company_id, vehicle_class_id, scheduled_at')
      .eq('status', 'scheduled')
      .is('driver_id', null)
      .is('preferred_driver_id', null)
      .gte('scheduled_at', windowStart.toISOString())
      .lt('scheduled_at', windowEnd.toISOString())
      .order('scheduled_at', { ascending: true })

    if (ridesErr) return json({ error: ridesErr.message }, 500)
    if (!openRides || openRides.length === 0) {
      console.log('[digest] no open rides for tomorrow — nothing to send')
      return json({ sent: 0, companies: 0 })
    }

    const byCompany = new Map<string, OpenRide[]>()
    for (const r of openRides as OpenRide[]) {
      if (!r.company_id) continue
      const list = byCompany.get(r.company_id) ?? []
      list.push(r)
      byCompany.set(r.company_id, list)
    }

    const messages: Record<string, unknown>[] = []

    for (const [companyId, rides] of byCompany) {
      // NOTE — the audience here is deliberately NOT isDriverDispatchable(), and
      // this is the one driver-read site where that convention does not apply.
      // Dispatchability means "online and reachable RIGHT NOW", which is the
      // right question for an offer that must be answered in 30 seconds. It is
      // the wrong question for a message about tomorrow: filtering on is_active
      // would reach only the drivers on shift at send time — precisely the ones
      // NOT sitting down to plan tomorrow. A push_token is the only thing
      // genuinely required, because without one there is nothing to send to.
      const { data: drivers, error: drvErr } = await supabase
        .from('drivers')
        .select('id, push_token, vehicle_class_id')
        .eq('company_id', companyId)
        .not('push_token', 'is', null)

      if (drvErr) {
        console.error(`[digest] company ${companyId}: ${drvErr.message}`)
        continue
      }
      if (!drivers || drivers.length === 0) continue

      for (const driver of drivers) {
        // Mirror claim-scheduled-ride's class rule exactly: a driver with a null
        // vehicle_class_id can take anything, and a ride with a null class can
        // be taken by anyone. Counting rides this driver would be REJECTED for
        // is worse than staying quiet — "3 rides open" that yields nothing
        // claimable teaches them to ignore the digest.
        const eligible = rides.filter(
          (r) =>
            !r.vehicle_class_id ||
            driver.vehicle_class_id === null ||
            driver.vehicle_class_id === r.vehicle_class_id
        )
        if (eligible.length === 0) continue

        const first = new Date(eligible[0].scheduled_at).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: TZ,
        })
        const n = eligible.length

        messages.push({
          to: driver.push_token,
          title: '🗓 Tomorrow’s open rides',
          body:
            `${n} scheduled ${n === 1 ? 'ride is' : 'rides are'} open for tomorrow — ` +
            `first at ${first}. Tap to claim one.`,
          data: { type: 'available_rides_digest', companyId, count: n },
          sound: 'default',
          priority: 'normal', // not time-critical, unlike a ride offer
        })
      }
    }

    // One request per 100 messages rather than one per driver: a company with a
    // real fleet is hundreds of sends, and Expo rate-limits per-request.
    let sent = 0
    for (let i = 0; i < messages.length; i += EXPO_BATCH_MAX) {
      const chunk = messages.slice(i, i + EXPO_BATCH_MAX)
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
        // Receipts are NOT polled here. A fan-out to every tokened driver is
        // exactly where stale tokens surface as DeviceNotRegistered, but that
        // fix belongs to the open push-receipts work — nulling tokens from the
        // digest would half-build it in the wrong place.
        sent += chunk.length
      } catch (e) {
        console.error('[digest] expo send failed', e)
      }
    }

    console.log(
      `[digest] ${sent} push(es) across ${byCompany.size} company/companies ` +
      `for ${windowStart.toISOString()} → ${windowEnd.toISOString()}`
    )
    return json({ sent, companies: byCompany.size, rides: openRides.length })
  } catch (error) {
    console.error('scheduled-ride-digest error:', error)
    return json({ error: String((error as Error).message ?? error) }, 500)
  }
})
