import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

// Breadcrumb history: the trail of where a driver has been, as opposed to
// drivers.current_lat/lng which is only where they are now. This is the half a
// taxi company is actually replacing a GPS tracker with — "what route did car 7
// take at 2pm Tuesday, how long did it sit idle".
//
// Fixes are BUFFERED, not posted one by one. During a fare the task fires every
// ~8s; a round trip per fix is a mobile radio wake per fix, which is the
// battery cost the tiered cadence in driverLocation.ts exists to avoid, and it
// throws away every point taken in a dead zone. Buffering flushes on a count or
// an age, whichever comes first.

const BUFFER_KEY = "driver.breadcrumbs.buffer";
const COMPANY_KEY = "driver.breadcrumbs.company";

/** Flush when this many fixes are waiting… */
const FLUSH_COUNT = 10;
/** …or when the oldest has been waiting this long, whichever comes first. */
const FLUSH_AGE_MS = 60_000;
/**
 * Hard cap on the buffer. A driver in a long dead zone must not grow this
 * without bound; past the cap the OLDEST fixes are dropped, because the recent
 * trail is what dispatch and a dispute both care about. At the ride cadence
 * this is roughly an hour of offline driving.
 */
const MAX_BUFFERED = 450;

export type Breadcrumb = {
  recorded_at: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  ride_id: string | null;
};

// The location task can fire again while a previous flush is still awaiting, and
// the buffer is a read-modify-write on AsyncStorage — without serialising, two
// callbacks interleave and one silently discards the other's fixes. Every entry
// point below goes through this chain.
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

async function readBuffer(): Promise<Breadcrumb[]> {
  try {
    const raw = await AsyncStorage.getItem(BUFFER_KEY);
    return raw ? (JSON.parse(raw) as Breadcrumb[]) : [];
  } catch {
    return [];
  }
}

async function writeBuffer(rows: Breadcrumb[]): Promise<void> {
  try {
    await AsyncStorage.setItem(BUFFER_KEY, JSON.stringify(rows));
  } catch {
    // Losing the buffer costs history, never a ride. Never throw into the task.
  }
}

/**
 * The driver's company, cached. Read once per install rather than per fix: it
 * cannot change without the driver being re-onboarded, and the task context may
 * have no warm session to spare a round trip on.
 */
async function getCompanyId(driverId: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(COMPANY_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as { driverId: string; companyId: string };
      // Keyed by driver, not stored bare. Two drivers sharing a phone (a shift
      // handover, a re-onboarded device) would otherwise inherit the first
      // one's company id, every INSERT would fail the policy's company check,
      // and the buffer would retry the same rejected rows forever.
      if (cached.driverId === driverId) return cached.companyId;
    }
  } catch {
    // fall through to the fetch
  }
  const { data } = await supabase
    .from("profiles")
    .select("company_id")
    .eq("id", driverId)
    .maybeSingle();
  const companyId = data?.company_id ?? null;
  if (companyId) {
    try {
      await AsyncStorage.setItem(
        COMPANY_KEY,
        JSON.stringify({ driverId, companyId }),
      );
    } catch {
      // Uncached is slower, not wrong.
    }
  }
  return companyId;
}

export async function clearBreadcrumbCache(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([BUFFER_KEY, COMPANY_KEY]);
  } catch {
    // Best effort.
  }
}

/**
 * Record one fix. Flushes when the buffer is full enough or old enough.
 * Never throws — a breadcrumb failure must never take down the location task
 * that also carries the liveness beat.
 */
export async function recordFix(
  driverId: string,
  crumb: Breadcrumb,
): Promise<void> {
  return recordFixes(driverId, [crumb]);
}

/**
 * Record a whole delivered batch in ONE buffer read-modify-write. The task can
 * be handed 30 fixes at once after a late delivery; appending them one at a
 * time re-parses and re-serialises a 450-element array 30 times on a phone.
 */
export async function recordFixes(
  driverId: string,
  crumbs: Breadcrumb[],
): Promise<void> {
  if (crumbs.length === 0) return;
  return serialise(async () => {
    let rows = await readBuffer();
    rows.push(...crumbs);
    if (rows.length > MAX_BUFFERED) rows = rows.slice(rows.length - MAX_BUFFERED);

    const oldest = rows[0];
    const dueByAge =
      oldest != null && Date.now() - new Date(oldest.recorded_at).getTime() >= FLUSH_AGE_MS;

    if (rows.length < FLUSH_COUNT && !dueByAge) {
      await writeBuffer(rows);
      return;
    }
    await flushRows(driverId, rows);
  });
}

/** Flush whatever is buffered — called when a shift ends, so nothing is stranded. */
export async function flushBreadcrumbs(driverId: string): Promise<void> {
  return serialise(async () => {
    const rows = await readBuffer();
    if (rows.length === 0) return;
    await flushRows(driverId, rows);
  });
}

async function flushRows(driverId: string, rows: Breadcrumb[]): Promise<void> {
  const companyId = await getCompanyId(driverId);
  if (!companyId) {
    // Without a company id the INSERT policy would reject every row. Keep them
    // buffered rather than dropping them: this is usually a cold cache with no
    // session yet, and the next flush will have one.
    await writeBuffer(rows);
    return;
  }

  const { error, status } = await supabase.from("driver_locations").insert(
    rows.map((r) => ({
      driver_id: driverId,
      company_id: companyId,
      ride_id: r.ride_id,
      recorded_at: r.recorded_at,
      lat: r.lat,
      lng: r.lng,
      heading: r.heading,
      speed: r.speed,
      accuracy: r.accuracy,
    })),
  );

  if (error) {
    // Not all failures are equal, and treating them alike is a silent stall:
    // a PERMANENT rejection re-sent on every subsequent fix poisons the buffer
    // forever, history stops, and the live dot keeps working so nothing looks
    // wrong. The concrete path is ride_id — it is persisted so it survives a
    // headless relaunch, which means it also survives a crash mid-ride, and a
    // ride deleted in the meantime makes every row fail the foreign key (23503)
    // for good.
    //
    // status 0 is the offline case specifically: PostgREST does NOT throw on a
    // network failure, it RESOLVES with an error and status 0.
    if (status === 0 || status >= 500) {
      await writeBuffer(rows);
      return;
    }
    console.warn(
      `[Breadcrumbs] dropping ${rows.length} fixes — permanent error ` +
        `${status} ${error.code ?? ""}: ${error.message}`,
    );
    await writeBuffer([]);
    return;
  }
  await writeBuffer([]);
}
