// Will taking this trip make a driver late for a scheduled pickup they've
// already confirmed?
//
// Single source of truth, same reason fare.ts and presence.ts exist: two places
// ask this question and they must never drift. `assign-ride` asks it to decide
// whether to auto-offer; `check-ride-conflicts` asks it on dispatch's behalf
// when they open the assign-driver picker. If those two disagreed, the
// dashboard would show a driver as safe while dispatch had been refused them.

// ── Tunables ────────────────────────────────────────────────────────────────
// Overridable per-environment without redeploying the logic. SAFETY_MARGIN is
// the honest admission that every term below is an estimate.
function envMins(key: string, fallback: number): number {
  const v = Number(Deno.env.get(key))
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
/** Be at the pickup this many minutes early. */
export const ARRIVAL_BUFFER_MINS = envMins('DISPATCH_ARRIVAL_BUFFER_MINS', 3)
/** Passenger walking out, loading, settling up. */
export const BOARDING_MINS = envMins('DISPATCH_BOARDING_MINS', 3)
/** Slack on the whole chain before a commitment counts as threatened. */
export const SAFETY_MARGIN_MINS = envMins('DISPATCH_SAFETY_MARGIN_MINS', 5)
/**
 * How far ahead a commitment can sit and still be worth loading. Bounds the DB
 * lookup only — it is NOT a behavioural threshold. Whether a driver is actually
 * at risk is decided by the arithmetic in evaluate(), never by this number.
 */
export const COMMITMENT_LOOKAHEAD_MINS = envMins('DISPATCH_COMMITMENT_LOOKAHEAD_MINS', 180)

const ROAD_WINDING_FACTOR = 1.35
const REPOSITION_SPEED_KMH = 55

export interface Commitment {
  ride_id: string
  scheduled_at: string
  pickup_lat: number
  pickup_lng: number
}

export interface Verdict {
  misses: boolean
  /** When the driver would be back on the road, ISO. */
  free_at: string | null
  /** Latest they can arrive at the scheduled pickup, ISO. */
  due_at: string
  /** Positive = minutes late. Negative = minutes to spare. */
  minutes_short: number | null
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// The leg from this trip's dropoff to the commitment's pickup. Deliberately
// Haversine, not Distance Matrix: it's the smallest term in the chain, it is
// per-driver (so accuracy would cost one element each, not one total), and
// SAFETY_MARGIN_MINS covers more error than it introduces.
export function repositionMins(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
): number {
  const km = distanceKm(fromLat, fromLng, toLat, toLng) * ROAD_WINDING_FACTOR
  return (km / REPOSITION_SPEED_KMH) * 60
}

/**
 * NOTE — rides.leave_by is deliberately NOT an input, though it looks like the
 * obvious one. It encodes a departure computed from where the driver stood at
 * release; after this trip they're at its dropoff instead, so its origin
 * assumption is void. Deriving the deadline from scheduled_at keeps one model
 * for both the released and not-yet-released cases.
 */
export function evaluate(
  c: Commitment,
  startMs: number,            // when this trip begins: now, or its scheduled_at
  driveToPickupMins: number,
  tripMins: number,
  dropoffLat: number,
  dropoffLng: number,
): Verdict {
  const dueMs = new Date(c.scheduled_at).getTime() - ARRIVAL_BUFFER_MINS * 60_000
  const due_at = new Date(dueMs).toISOString()

  // Fail closed. A non-finite input would make every comparison below false and
  // quietly wave the driver through — fail-OPEN, in the one place everything
  // else is fail-closed. Never guess against a commitment.
  if (![startMs, driveToPickupMins, tripMins, dropoffLat, dropoffLng].every(Number.isFinite)) {
    return { misses: true, free_at: null, due_at, minutes_short: null }
  }

  const freeAtMs = startMs + (driveToPickupMins + BOARDING_MINS + tripMins) * 60_000
  const arriveMs = freeAtMs + repositionMins(dropoffLat, dropoffLng, c.pickup_lat, c.pickup_lng) * 60_000
  const slackMs  = arriveMs + SAFETY_MARGIN_MINS * 60_000 - dueMs

  return {
    misses: slackMs > 0,
    free_at: new Date(arriveMs).toISOString(),
    due_at,
    minutes_short: Math.round(slackMs / 60_000),
  }
}
