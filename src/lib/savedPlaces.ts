import { supabase } from "./supabase";

/**
 * Passenger saved places — Home / Work / named destinations.
 *
 * The point of this table over the old hardcoded QUICK_DESTINATIONS list is
 * that a row carries COORDINATES. The old chips held address strings, so
 * tapping one ran a Places Autocomplete and then a Places Details before the
 * passenger had a destination. Everything here resolves offline, for free.
 *
 * See .claude/notes/quick-destinations-plan.md.
 */

export type PlaceKind = "home" | "work" | "custom";

export interface SavedPlace {
  id: string;
  kind: PlaceKind;
  /** Null for home/work — those take their label from the kind. */
  name: string | null;
  /** Full string, what gets stored as the ride's address. */
  address: string;
  /** Short form for the input row and the chip. */
  display: string;
  lat: number;
  lng: number;
  last_used_at: string | null;
}

const COLUMNS = "id, kind, name, address, display, lat, lng, last_used_at";

/** What the chip shows. Home/Work are roles, so their label is fixed. */
export function placeLabel(p: SavedPlace): string {
  if (p.kind === "home") return "Home";
  if (p.kind === "work") return "Work";
  return p.name ?? p.display;
}

export function placeIcon(kind: PlaceKind): "home" | "briefcase" | "star" {
  if (kind === "home") return "home";
  if (kind === "work") return "briefcase";
  return "star";
}

/**
 * Home first, then Work, then everything else most-recently-used first.
 *
 * Ordered in JS rather than SQL because the kind ordering isn't expressible as
 * a plain column sort and the row count is capped at 20 — a CASE in the query
 * would buy nothing.
 */
function order(rows: SavedPlace[]): SavedPlace[] {
  const rank = (k: PlaceKind) => (k === "home" ? 0 : k === "work" ? 1 : 2);
  return [...rows].sort((a, b) => {
    if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind);
    return (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
  });
}

export async function fetchSavedPlaces(
  passengerId: string,
): Promise<SavedPlace[]> {
  const { data, error } = await supabase
    .from("passenger_places")
    .select(COLUMNS)
    .eq("passenger_id", passengerId);
  // A failed fetch RESOLVES as {error, status:0} rather than throwing, so this
  // check is the only thing standing between an offline launch and a crash.
  if (error) {
    console.warn("fetchSavedPlaces", error.message);
    return [];
  }
  return order((data ?? []) as SavedPlace[]);
}

/**
 * Same 4dp (~11m) bucket as passenger_places_one_per_spot in 20260778, so the
 * two agree on all but the boundary cases — two points either side of a
 * rounding edge can collide in the index while this returns false, and vice
 * versa. That is fine and deliberate: this only decides whether to OFFER the
 * save button. The unique index is the authority, and savePlace() turns its
 * 23505 into "That place is already saved."
 */
export function coordKey(lat: number, lng: number): string {
  return `${Math.round(lat * 1e4)}:${Math.round(lng * 1e4)}`;
}
function near(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return coordKey(a.lat, a.lng) === coordKey(b.lat, b.lng);
}

/**
 * Chip label for a place we only have a full address string for — i.e. a past
 * ride's `dropoff_address`, which has no `display` column to fall back on.
 *
 * First comma segment, because that is where Places puts the thing worth
 * showing in both shapes an address arrives in: "Valley Regional Hospital,
 * Kentville, NS" gives the venue, "1234 Main St, Kentville, NS" gives the
 * street address. Saved places don't use this — they carry a real `display`
 * captured from structured_formatting at save time.
 */
export function shortLabel(address: string): string {
  const head = address.split(",")[0]?.trim();
  return head && head.length > 0 ? head : address;
}

/** Is this spot already saved? Used to flip the confirm-sheet save button. */
export function findSaved(
  places: SavedPlace[],
  coords: { latitude: number; longitude: number },
): SavedPlace | undefined {
  return places.find((p) =>
    near(p, { lat: coords.latitude, lng: coords.longitude }),
  );
}

export interface NewPlace {
  kind: PlaceKind;
  name: string | null;
  address: string;
  display: string;
  lat: number;
  lng: number;
}

/**
 * Returns an error message for the passenger, or null on success.
 *
 * Two DB-enforced failures reach here as codes rather than prose: 23505 is
 * either "already saved" or "you already have a Home/Work", and the cap trigger
 * raises check_violation at 20 rows.
 */
export async function savePlace(
  passengerId: string,
  place: NewPlace,
): Promise<string | null> {
  const { error } = await supabase
    .from("passenger_places")
    .insert({ passenger_id: passengerId, ...place });
  if (!error) return null;
  if (error.code === "23505") {
    return place.kind === "custom"
      ? "That place is already saved."
      : `You already have a ${place.kind === "home" ? "Home" : "Work"} saved. Remove it first.`;
  }
  if (error.message?.includes("limit reached")) {
    return "You've saved the maximum of 20 places.";
  }
  console.warn("savePlace", error.message);
  return "Couldn't save that place. Try again.";
}

export async function deletePlace(id: string): Promise<void> {
  const { error } = await supabase
    .from("passenger_places")
    .delete()
    .eq("id", id);
  if (error) console.warn("deletePlace", error.message);
}

/** Re-label an existing place — used by "Set as Home" / "Set as Work". */
export async function updatePlaceKind(
  id: string,
  kind: PlaceKind,
  name: string | null,
): Promise<string | null> {
  const { error } = await supabase
    .from("passenger_places")
    .update({ kind, name: kind === "custom" ? name : null })
    .eq("id", id);
  if (!error) return null;
  if (error.code === "23505") {
    return `You already have a ${kind === "home" ? "Home" : "Work"} saved.`;
  }
  console.warn("updatePlaceKind", error.message);
  return "Couldn't update that place.";
}

/**
 * Bump ordering after a chip is used. Fire-and-forget on purpose: this is a
 * sort key, and a passenger who just tapped a destination should not wait on
 * a round trip, nor see an error if it fails.
 */
export function touchPlace(id: string): void {
  void supabase
    .from("passenger_places")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .then(({ error }) => {
      if (error) console.warn("touchPlace", error.message);
    });
}
