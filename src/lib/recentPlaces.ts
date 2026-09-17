import { supabase } from "./supabase";
import { coordKey, shortLabel, type SavedPlace } from "./savedPlaces";

/**
 * Recent destinations — the passenger's own last few completed dropoffs.
 *
 * This is the second tier of the idle chip row, under saved places. It needs
 * no table, no Places call and no cross-passenger data: `rides` already
 * carries the address and the coordinates, and the passenger can already read
 * their own rides under existing RLS (it is the same read `RideHistoryScreen`
 * does).
 *
 * The point of it: a saved place only exists if someone went to a settings
 * flow, but anyone who has taken one ride has a destination worth offering.
 * That shrinks the "nothing to show" state down to brand-new passengers, who
 * get the Add Home / Add Work slots instead.
 *
 * See .claude/notes/quick-destinations-plan.md.
 */

export interface RecentPlace {
  /** Coord-bucket key — also the React list key. */
  key: string;
  /** Full string, exactly what gets stored as the next ride's address. */
  address: string;
  /** Short form for the chip, derived — rides have no `display` column. */
  display: string;
  lat: number;
  lng: number;
}

/** How many completed rides to look back over before deduping. */
const SCAN = 20;

/**
 * ~0.003° ≈ 330 m. Deliberately much looser than the 4dp (~11 m) dedupe
 * bucket: this answers "am I standing here already", where being one building
 * over still means the chip is useless. Plain delta box rather than haversine
 * — at this latitude and this tolerance the difference is noise, and this runs
 * on every pickup change.
 */
const AT_PICKUP_DEG = 0.003;

interface RideRow {
  dropoff_address: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
}

/**
 * Most recent distinct completed dropoffs, newest first.
 *
 * Ordered by `completed_at`, never `updated_at` — `updated_at` moves on any
 * write to the row, including unrelated backfills, which is the house rule for
 * anything time-ordered off `rides`.
 *
 * Cancelled rides are excluded on purpose: a cancelled ride's dropoff is a
 * place the passenger never went, so offering it back is worse than offering
 * nothing.
 */
export async function fetchRecentPlaces(
  passengerId: string,
): Promise<RecentPlace[]> {
  const { data, error } = await supabase
    .from("rides")
    .select("dropoff_address, dropoff_lat, dropoff_lng")
    .eq("passenger_id", passengerId)
    .eq("status", "completed")
    // nullsFirst: false because Postgres defaults DESC to NULLS FIRST, and
    // completed_at only exists from 20260718 onward — any older completed ride
    // that the backfill missed would otherwise sort to the FRONT and eat the
    // whole scan window, so the newest destinations never appear.
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(SCAN);
  // A failed fetch RESOLVES as {error, status:0} rather than throwing, so this
  // check is the only thing between an offline launch and a crash.
  if (error) {
    console.warn("fetchRecentPlaces", error.message);
    return [];
  }

  // Deduped in JS rather than with DISTINCT ON: the dedupe is on ROUNDED
  // coordinates (the same 4dp bucket the saved-places unique index uses, since
  // the same door arrives spelled several ways across Places predictions), and
  // the scan is 20 rows.
  const seen = new Set<string>();
  const out: RecentPlace[] = [];
  for (const r of (data ?? []) as RideRow[]) {
    if (!r.dropoff_address || r.dropoff_lat == null || r.dropoff_lng == null)
      continue;
    const key = coordKey(r.dropoff_lat, r.dropoff_lng);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      address: r.dropoff_address,
      display: shortLabel(r.dropoff_address),
      lat: r.dropoff_lat,
      lng: r.dropoff_lng,
    });
  }
  return out;
}

/**
 * What actually reaches the chip row.
 *
 * Two filters, both about not wasting a slot:
 *  - drop anything already saved, so Home doesn't appear twice in one row;
 *  - drop anything at the current pickup. The most recent completed dropoff is
 *    very often exactly where the passenger is standing — they just got here —
 *    and "go to where you already are" is the most visible way this tier can
 *    look broken.
 */
export function visibleRecents(
  recents: RecentPlace[],
  saved: SavedPlace[],
  pickup: { latitude: number; longitude: number } | null | undefined,
  limit: number,
): RecentPlace[] {
  const savedKeys = new Set(saved.map((p) => coordKey(p.lat, p.lng)));
  return recents
    .filter((r) => !savedKeys.has(r.key))
    .filter(
      (r) =>
        !pickup ||
        Math.abs(r.lat - pickup.latitude) > AT_PICKUP_DEG ||
        Math.abs(r.lng - pickup.longitude) > AT_PICKUP_DEG,
    )
    .slice(0, limit);
}
