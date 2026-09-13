/**
 * Display formatting for the human-readable identifiers.
 *
 * Storage and display are deliberately separate:
 *   • rides.ride_ref is stored bare (6 chars, no separator) so the unique index
 *     is on the canonical value and a search can match what a passenger typed
 *     with or without the space.
 *   • drivers.driver_number is stored as an int, because it is issued from a
 *     per-company counter; the prefix and padding are the company's display
 *     convention and can change without rewriting anyone's number.
 *   • drivers.car_number is stored as TEXT already rendered — it is whatever is
 *     painted on the car, which dispatch types in and can be "12A".
 *
 * See supabase/migrations/20260774_ride_ref.sql and 20260775_fleet_numbering.sql.
 */

/** Company display settings, as stored on the `companies` row. */
export interface NumberFormat {
  prefix: string;
  pad: number;
}

/**
 * "K7M4Q2" -> "K7M 4Q2".
 *
 * Grouped 3-3 purely for reading: dispatch reads these aloud over the radio and
 * a passenger reads one back to support. The alphabet has no vowels, so the
 * code can never accidentally spell a word, but six unbroken characters are
 * still hard to hold in your head.
 */
export function formatRideRef(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.length === 6 ? `${ref.slice(0, 3)} ${ref.slice(3)}` : ref;
}

/** Strips the display space so typed input matches the stored value. */
export function normalizeRideRef(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/**
 * Renders a driver number under the company's convention.
 * formatNumber(7, { prefix: "D-", pad: 3 })  -> "D-007"
 * formatNumber(7, { prefix: "",   pad: 0 })  -> "7"       (Casino's convention)
 */
export function formatNumber(
  n: number | null | undefined,
  fmt: NumberFormat | null | undefined,
): string {
  if (n === null || n === undefined) return "";
  const prefix = fmt?.prefix ?? "";
  const pad = fmt?.pad ?? 0;
  return prefix + String(n).padStart(pad, "0");
}
