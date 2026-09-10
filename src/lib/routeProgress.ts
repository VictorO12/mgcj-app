// Route geometry maths, shared by the driver's active-ride screen and the
// background location task.
//
// It lives here because BOTH have to answer "how far is left, and therefore
// what is the ETA" from the same polyline. The screen does it every GPS tick
// while it is on screen; the task does it while the app is backgrounded, which
// is the case the passenger used to see as a frozen countdown. Two copies of
// this arithmetic would drift, and the symptom would be an ETA that jumps
// whenever the driver locks their phone.

export type LatLng = { latitude: number; longitude: number };

/** Great-circle distance in metres. */
export function getDistance(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Remaining distance (m) from `loc` to the end of the route polyline. Snaps to
 * the nearest polyline vertex, then sums the leg lengths from there to the
 * destination. Cheap (a few hundred points) and safe to run every GPS tick.
 */
export function remainingRouteDistance(
  loc: LatLng,
  coords: LatLng[],
): number | null {
  if (coords.length < 2) return null;
  let nearestIdx = 0;
  let minD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = getDistance(loc, coords[i]);
    if (d < minD) {
      minD = d;
      nearestIdx = i;
    }
  }
  let rem = getDistance(loc, coords[nearestIdx]);
  for (let i = nearestIdx; i < coords.length - 1; i++) {
    rem += getDistance(coords[i], coords[i + 1]);
  }
  return rem;
}

/** Distance (m) from `loc` to the nearest vertex of the route. */
export function distanceToRoute(loc: LatLng, coords: LatLng[]): number | null {
  if (coords.length === 0) return null;
  let minD = Infinity;
  for (const point of coords) {
    const d = getDistance(loc, point);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * How far off the route a driver may be before an interpolated ETA stops
 * meaning anything. The screen's own off-route detector trips at 50m and then
 * REROUTES; the background task cannot reroute (a Directions call per fix is
 * the Maps bill this whole ETA design exists to avoid), so it needs a wider
 * band before it gives up — a driver going round a block is still broadly on
 * the route, a driver who took a different road entirely is not.
 */
const OFF_ROUTE_M = 250;

/**
 * A stored route this old is not describing the drive any more — the driver has
 * plainly gone somewhere the polyline does not cover, or the ride ended without
 * the route being cleared.
 */
const ROUTE_STALE_MS = 45 * 60_000;

/**
 * ETA in seconds from a driver position, a route and the route's average speed,
 * or null when the answer would be a guess.
 *
 * Null is deliberate and better than a stale number: the passenger UI renders
 * no ETA rather than a wrong one, and a countdown that is confidently wrong is
 * worse than an absent one — it is the same failure as the frozen ETA, only
 * harder to notice.
 */
export function etaSecondsFromRoute(
  loc: LatLng,
  route: { coords: LatLng[]; avgSpeed: number | null; capturedAt: number },
  now: number = Date.now(),
): number | null {
  if (!route.avgSpeed || route.avgSpeed <= 0) return null;
  if (route.coords.length < 2) return null;
  if (now - route.capturedAt > ROUTE_STALE_MS) return null;

  const off = distanceToRoute(loc, route.coords);
  if (off == null || off > OFF_ROUTE_M) return null;

  const rem = remainingRouteDistance(loc, route.coords);
  if (rem == null) return null;
  return Math.round(rem / route.avgSpeed);
}
