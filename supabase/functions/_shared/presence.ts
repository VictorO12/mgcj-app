// Single source of truth for driver "liveness" across every dispatch read-site
// (assign-ride, scheduled-release, scheduled-coverage-monitor,
// broadcast-scheduled-ride). Keep this the ONLY place the staleness threshold
// lives so the sites can't drift — same discipline as _shared/fare.ts.
//
// The mobile app heartbeats `drivers.last_seen_at` every ~10s while online and
// foregrounded (useDriverLocationBroadcast). A driver whose `is_active` is still
// true but hasn't heartbeated within PRESENCE_STALE_MS is a "phantom": they
// closed/backgrounded the app or forgot to go offline, so they can't actually
// see or accept a ride offer. Phantoms must be excluded from dispatch and from
// coverage math even though their flag still reads online.
//
// NULL last_seen_at is treated as LIVE, not stale. This is deliberate and
// transitional: app builds shipped before the heartbeat wrote this column don't
// populate it, and store/EAS rollouts aren't atomic, so right after deploy some
// genuinely-online drivers still have NULL. Treating NULL as live avoids
// wrongly dropping every not-yet-updated driver. Once the heartbeat build is
// universal, no active driver has NULL and this tolerance is moot — at which
// point the `.is.null` branch below can be dropped to make the filter strict.

export const PRESENCE_STALE_MS = 60_000; // 6 missed 10s beats; tolerates a network blip

export function livenessCutoffISO(now: Date = new Date()): string {
  return new Date(now.getTime() - PRESENCE_STALE_MS).toISOString();
}

// PostgREST `.or(...)` argument for server-side filtering. AND-combines with the
// rest of the query. Usage: query.or(livenessOrFilter())
//
// NO LONGER USED BY ANY DISPATCH POOL as of 20260766: assign-ride and
// scheduled-release both stopped filtering on liveness and now rank with
// preferLive() instead, because a hard filter failed toward `no_drivers` when
// every driver in a small company had simply pocketed their phone. Kept because
// it is the right shape for a read that genuinely wants only fresh rows (a
// live-map query, say) — but think twice before reintroducing it on anything
// that decides who gets offered a ride.
export function livenessOrFilter(now: Date = new Date()): string {
  return `last_seen_at.is.null,last_seen_at.gte.${livenessCutoffISO(now)}`;
}

// JS-side predicate for sites that fetch the roster and filter in memory.
export function isDriverLive(
  d: { is_active?: boolean | null; last_seen_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (!d.is_active) return false;
  if (d.last_seen_at == null) return true; // transitional: unknown ≠ stale (see header)
  return new Date(d.last_seen_at).getTime() >= now.getTime() - PRESENCE_STALE_MS;
}

// ── Dispatchability = liveness + reachability ────────────────────────────────
// A ride offer IS a push notification, so a driver with no push_token can never
// be told a ride exists: assign-ride filters them out (`.not('push_token','is',
// null)`), and offering one would just park the ride until reassign-stale-rides
// cycles it 60s later.
//
// Coverage math must use the SAME definition as dispatch, or the two disagree in
// the dangerous direction: the dashboard reads `covered` for a shift where
// nobody is actually reachable, while assign-ride quietly returns `no_drivers`.
// Both signals then fail toward false confidence. Coverage answers "can this
// ride be served?", and a driver who cannot receive an offer is not capacity.
//
// Note this is about *reachable* capacity, not roster size. Sites that ask "does
// this company employ any driver of this class at all" (the uncovered-vs-at_risk
// distinction) should keep counting the raw roster — a company whose drivers are
// all offline is at_risk, not structurally uncovered.

export const DISPATCHABLE_COLUMNS = 'id, is_active, last_seen_at, push_token';

export function isDriverDispatchable(
  d: { is_active?: boolean | null; last_seen_at?: string | null; push_token?: string | null },
  now: Date = new Date(),
): boolean {
  if (!isDriverLive(d, now)) return false;
  return d.push_token != null && d.push_token !== '';
}

// ── Dispatch tiering: prefer live, but never exclude to the point of nobody ──
//
// The 60s window above answers "who have we heard from recently", and that is a
// good way to CHOOSE between drivers: a driver with the app open answers faster
// and their position is fresh, so the ETA is right. It is a bad way to decide
// who is unreachable, for one blunt reason: A RIDE OFFER IS A PUSH
// NOTIFICATION. Push reaches a locked phone, a backgrounded app, and an app the
// driver force-quit an hour ago. The heartbeat stops in all three cases (it is
// a foreground-only setInterval — there are no background modes in the app), so
// the old hard filter excluded drivers from the one channel that still reaches
// them.
//
// Worse, it failed toward nobody: when every driver in a small company had gone
// quiet, assign-ride returned `no_drivers` and the passenger was told nobody was
// available while three drivers sat parked nearby with phones in their pockets.
//
// So: rank, don't exclude. Live drivers first; fall back to the quiet ones only
// when there are no live ones. Offering to a driver who really has gone home
// costs one 30s offer timeout and then reassign-stale-rides cycles — machinery
// that already exists and already runs — and that is a far better trade than
// dropping the ride.
//
// NOTE this deliberately does NOT try to distinguish "backgrounded" from
// "killed". An earlier draft added a `backgrounded_at` stamp for that; it was
// dropped because the stamp would be written at the same instant as the final
// heartbeat, so a minute later it carries nothing `last_seen_at` does not
// already carry — and because push reaches a killed app anyway, no decision
// here depends on the difference. It also would have misclassified the case
// that matters most: a driver in a dead zone with the app OPEN writes no stamp,
// and must stay in the fallback tier rather than being called gone.
export function preferLive<T extends { is_active?: boolean | null; last_seen_at?: string | null }>(
  pool: T[],
  now: Date = new Date(),
): { candidates: T[]; tier: 'live' | 'fallback' } {
  const live = pool.filter((d) => isDriverLive(d, now));
  if (live.length > 0) return { candidates: live, tier: 'live' };
  return { candidates: pool, tier: 'fallback' };
}
