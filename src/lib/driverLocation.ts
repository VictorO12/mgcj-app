import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { flushBreadcrumbs, flushIfDue, recordFixes } from "./breadcrumbs";
import { noteTaskEvent } from "./taskDiary";
import { probeAuthKeyRead } from "./secureStoreAccess";
import Constants from "expo-constants";

const SUPABASE_URL: string = Constants.expoConfig?.extra?.supabaseUrl ?? "";
import { getDeviceToken } from "./deviceSession";
import { etaSecondsFromRoute, type LatLng } from "./routeProgress";
import { supabase } from "./supabase";

// Background driver location. Runs as an Android foreground service / iOS
// background-location session for as long as the driver is online, so the
// dispatch map and the passenger's moving car keep updating when the app is
// backgrounded — a phone call, a screen lock, or the driver using their own
// nav app for the whole fare. Before this, all three froze the car and the ETA
// with no indication to the passenger that anything was wrong.
//
// PERMISSIONS: this deliberately needs only FOREGROUND location permission.
// Android takes the user-initiated-foreground-service path (expo-location's
// LocationModule.kt: passing `foregroundService` skips the
// ACCESS_BACKGROUND_LOCATION check), and iOS needs only When-In-Use plus the
// `location` UIBackgroundMode. That keeps us out of Play's background-location
// declaration process and off iOS's "Always" prompt. Do NOT add
// `isAndroidBackgroundLocationEnabled` to the config plugin to "make it more
// reliable" — it changes which policy regime the app is reviewed under.
export const DRIVER_LOCATION_TASK = "driver-location-updates";

/**
 * Cadence tiers. One mechanism, two settings — not two features.
 *
 * idle: a distance trigger. A parked driver emits nothing, which is correct:
 *   their last known point IS their current point.
 * ride: a time trigger, high accuracy. The passenger is watching this dot move
 *   and counting down an ETA off it, so gaps are visible to a customer.
 *
 * `timeInterval` is Android-only (iOS uses the distance filter), which is why
 * the ride tier sets both.
 */
type Cadence = "idle" | "ride";

// Which ride the current fixes belong to, so a breadcrumb can be attributed to
// a fare. Persisted rather than held in a module variable: the OS can relaunch
// this JS context headlessly to deliver a batch, and a fresh context would
// stamp a mid-ride trail as idle — losing exactly the rows a "the driver took
// the long way" dispute is answered from.
const ACTIVE_RIDE_KEY = "driver.location.activeRide";

// The driver this device is tracking, in AsyncStorage — deliberately NOT read
// back out of the session. The session lives in SecureStore, which is
// unreadable while the device is locked, and that read is exactly what stalls
// the task. History has to survive that, so the id it is filed under must come
// from a store with no keychain protection.
const DRIVER_ID_KEY = "driver.location.driverId";

async function setPersistedDriverId(driverId: string | null): Promise<void> {
  try {
    if (driverId) await AsyncStorage.setItem(DRIVER_ID_KEY, driverId);
    else await AsyncStorage.removeItem(DRIVER_ID_KEY);
  } catch {
    // Best effort; the task falls back to the session id.
  }
}

async function getPersistedDriverId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(DRIVER_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * A stalled keychain read is indistinguishable from a slow one, and the task
 * must not hang either way: 60 invocations hung on this in one 17-minute walk,
 * each leaving a pending promise behind. Resolving to a sentinel lets the task
 * finish and report, which is how the stall became visible at all.
 */
const SESSION_LOAD_TIMEOUT_MS = 8_000;

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), SESSION_LOAD_TIMEOUT_MS)),
  ]);
}

async function setActiveRideId(rideId: string | null): Promise<void> {
  try {
    if (rideId) await AsyncStorage.setItem(ACTIVE_RIDE_KEY, rideId);
    else await AsyncStorage.removeItem(ACTIVE_RIDE_KEY);
  } catch {
    // Worst case a fix is filed as idle; never worth failing a start over.
  }
}

// The route the driver is currently following, stashed by
// DriverActiveRideScreen on every Directions fetch so the background task can
// keep the passenger's ETA counting down while the app is backgrounded. Storing
// the polyline (rather than calling Directions from the task) is what keeps
// this free: the arithmetic is local, and a Maps call per fix is exactly the
// bill the local-interpolation design removed.
const ACTIVE_ROUTE_KEY = "driver.location.activeRoute";

export type StoredRoute = {
  rideId: string;
  coords: LatLng[];
  avgSpeed: number | null;
  capturedAt: number;
};

export async function setActiveRoute(route: StoredRoute | null): Promise<void> {
  try {
    if (route) await AsyncStorage.setItem(ACTIVE_ROUTE_KEY, JSON.stringify(route));
    else await AsyncStorage.removeItem(ACTIVE_ROUTE_KEY);
  } catch {
    // Worst case the backgrounded ETA goes null — the old behaviour, not worse.
  }
}

async function getActiveRoute(): Promise<StoredRoute | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_ROUTE_KEY);
    return raw ? (JSON.parse(raw) as StoredRoute) : null;
  } catch {
    return null;
  }
}

async function getActiveRideId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_RIDE_KEY);
  } catch {
    return null;
  }
}

const CADENCE: Record<Cadence, Location.LocationTaskOptions> = {
  idle: {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 150,
    // NOT 60s, even though that is the natural idle number: presence.ts (both
    // repos) calls a driver stale at exactly PRESENCE_STALE_MS = 60_000, so a
    // 60s beat lands on both sides of the line every tick and the dashboard's
    // online/away pill flickers for a driver who is simply parked. Half the
    // threshold keeps a backgrounded Android driver unambiguously "online".
    timeInterval: 30_000,
  },
  ride: {
    accuracy: Location.Accuracy.High,
    distanceInterval: 25,
    timeInterval: 8_000,
  },
};

function taskOptions(cadence: Cadence): Location.LocationTaskOptions {
  return {
    ...CADENCE[cadence],
    // Never let iOS decide the driver has stopped moving and pause updates —
    // waiting at a stand is not the end of a shift.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
    // The blue iOS status bar. User-visible and that is the point: this is the
    // honest signal that a shift is being tracked.
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "On shift",
      notificationBody: "Sharing your location with dispatch",
      notificationColor: "#1D9E75",
      // Keeps the service alive when the app is swiped out of recents, which
      // is the difference between "the driver tidied their app switcher" and
      // "dispatch lost them". Verified in LocationTaskService.kt: onTaskRemoved
      // only calls stop() when this is true. It does NOT survive a force-stop
      // from Settings or a reboot — nothing short of BOOT_COMPLETED would.
      killServiceOnDestroy: false,
    },
  };
}

/**
 * The write every location fix performs. Shared with the foreground heartbeat
 * in useDriverLocationBroadcast so the two can't drift on which columns a
 * position update touches.
 */
export async function writeDriverPosition(
  driverId: string,
  coords: { latitude: number; longitude: number; heading?: number | null; speed?: number | null } | null,
  /**
   * Passenger-facing ETA. `undefined` leaves the column alone (the screen owns
   * it while it is mounted); `null` clears it, which is the honest answer when
   * the driver is off the stored route and we have no way to recompute one.
   */
  etaSeconds?: number | null,
): Promise<"ok" | "displaced" | "skipped"> {
  const deviceToken = await getDeviceToken();
  if (!deviceToken) return "skipped"; // never claimed the lock; nothing to compare against

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    updated_at: now,
    // Liveness heartbeat. Dispatch RANKS on this rather than filtering, so a
    // stale beat costs a driver priority, not the ride.
    last_seen_at: now,
  };
  if (coords) {
    update.current_lat = coords.latitude;
    update.current_lng = coords.longitude;
    update.heading = courseOrNull(coords);
  }
  if (etaSeconds !== undefined) {
    update.active_ride_eta_seconds = etaSeconds;
  }

  const { data, error } = await supabase
    .from("drivers")
    .update(update)
    .eq("id", driverId)
    // Compare-and-set: this only lands while this device still holds the
    // session lock. Zero rows back means another device claimed the account.
    .eq("device_token", deviceToken)
    .select("id");

  if (error) return "skipped";
  return (data?.length ?? 0) === 0 ? "displaced" : "ok";
}

/**
 * A GPS course worth broadcasting, or null.
 *
 * Gated on speed, not just on the iOS -1 sentinel: Android's
 * Location.getBearing() returns a plain 0.0 when it has no bearing, which
 * would pass a `>= 0` check and point every parked car due north. Below
 * ~1 m/s write null and let the passenger client derive the bearing from
 * position deltas instead.
 */
export function courseOrNull(coords: {
  heading?: number | null;
  speed?: number | null;
}): number | null {
  const { heading, speed } = coords;
  if (heading == null || heading < 0) return null;
  if (speed == null || speed < 1) return null;
  return heading;
}

// Defined at module scope, imported for its side effect from App.tsx. If a
// headless relaunch delivers a batch before the task name is registered, the
// batch is dropped and the only trace is a warning nobody sees on a device.
TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    await noteTaskEvent("task error", error.message);
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations;
  await noteTaskEvent("task entered", `${locations?.length ?? 0} fixes`);
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  // EVERYTHING TOUCHING SecureStore COMES AFTER THIS BLOCK.
  //
  // The first cut of this fix buffered before the session's *usability* check
  // but after loadTaskSession() itself — which is where the stall actually is,
  // so it bought nothing and a 17-minute walk still lost every fix. AsyncStorage
  // reads fine while locked; the keychain does not. So the trail is written
  // first, from a persisted driver id, before anything can block.
  //
  // History gets EVERY fix in the batch; the live position column only gets the
  // newest. A batch that arrived late is several minutes of trail, and throwing
  // away all but the last point would draw the straight teleport line the
  // recorded_at column exists to avoid.
  const rideId = await getActiveRideId();
  const persistedDriverId = await getPersistedDriverId();
  if (persistedDriverId) {
    await recordFixes(
      persistedDriverId,
      (locations ?? []).map((fix) => ({
        recorded_at: new Date(fix.timestamp).toISOString(),
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        heading: courseOrNull(fix.coords),
        speed: fix.coords.speed ?? null,
        accuracy: fix.coords.accuracy ?? null,
        ride_id: rideId,
      })),
      false, // never flush here: the flush needs auth, which is what may stall
    );
    await noteTaskEvent("crumbs buffered", `${locations?.length ?? 0}`);
  }

  const session = await withTimeout(loadTaskSession(), {
    driverId: null,
    usable: false,
    note: "timed out — keychain likely locked",
  } as TaskSession);
  await noteTaskEvent(
    session.usable ? "session ok" : "session unusable",
    session.note,
  );
  // No readable session means no authenticated write. The crumbs above are
  // already safe, so this costs live position only.
  if (!session.driverId) return;
  const driverId = session.driverId;

  // The fixes are ALREADY buffered, above, before the keychain was touched.
  // Calling recordFixes again here re-appends the same batch and lands every
  // point twice — which it did, for two walks. Flush, never re-record.
  if (!session.usable) return;
  await flushIfDue(driverId);

  // Keep the passenger's countdown moving while the app is backgrounded. The
  // screen normally owns this column and computes the same number every GPS
  // tick — but it only runs while it is on screen, so a driver taking a call or
  // locking their phone used to freeze the ETA at whatever it last said. The
  // task recomputes it from the stored route, and writes NULL rather than a
  // stale number when the driver has left that route: no ETA is honest, a
  // confidently wrong one is the same bug in a costume.
  const eta =
    rideId != null
      ? await etaForFix(rideId, {
          latitude: latest.coords.latitude,
          longitude: latest.coords.longitude,
        })
      : undefined;

  const result = await writeDriverPosition(driverId, latest.coords, eta);
  await noteTaskEvent("position write", result);
  if (result === "displaced") {
    // Another device owns this account now. A device that lost the lock must
    // not keep writing position — dispatch would see two cars for one driver.
    console.warn("[Location] displaced — stopping background updates");
    await stopDriverLocationUpdates();
  }
});

async function etaForFix(
  rideId: string,
  loc: LatLng,
): Promise<number | null | undefined> {
  const route = await getActiveRoute();
  // A route belonging to a different ride tells us nothing about this one.
  if (!route || route.rideId !== rideId) return null;
  return etaSecondsFromRoute(loc, route);
}

type TaskSession = {
  /** Who the stored session belongs to. Survives the token being unusable. */
  driverId: string | null;
  /** Can we authenticate a write right now? */
  usable: boolean;
  /** Diary detail — why. */
  note: string;
};

/**
 * Resolve the session for a background task invocation.
 *
 * Replaces the old `resolveDriverId()`, which bailed rather than refreshing on
 * the theory that a rotation race could sign the driver out mid-shift. Two
 * things were wrong with that. First, the bail was very likely UNREACHABLE:
 * `getSession()` itself refreshes when the token is within EXPIRY_MARGIN_MS
 * (90s) of expiry, and the bail triggered under 60s — so anything old enough to
 * trip it had already been refreshed a line earlier. Reaching the bail at all
 * means the refresh FAILED, which is worth one explicit retry and, far more
 * importantly, worth recording.
 *
 * Second, the bail's premise — "a dropped fix costs nothing, the next one
 * covers it" — does not hold while backgrounded. Nothing refreshes the token
 * there, so the condition is absorbing rather than transient: every subsequent
 * fix fails the same way until the driver unlocks their phone.
 *
 * The driver id is returned even when the token is unusable, because the caller
 * still wants to BUFFER history under it. `getSession()` reads from storage, so
 * this identity is available with a dead token and needs no network.
 */
async function loadTaskSession(): Promise<TaskSession> {
  // TEMPORARY probe — splits "the keychain is locked" from "auth-js is stuck".
  // If the diary shows `ss probe` and then no `session` line, the keychain is
  // fine and getSession is hanging on something else (most likely a network
  // call inside _initialize, whose own 20s timeout also cannot fire while the
  // runloop is suspended). If `ss probe` itself never appears, it is the
  // keychain. Remove with taskDiary.
  await noteTaskEvent("ss probe", await probeAuthKeyRead(SUPABASE_URL));

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    return { driverId: null, usable: false, note: error?.message ?? "no session" };
  }
  const session = data.session;
  const lifeMs = (session.expires_at ?? 0) * 1000 - Date.now();
  if (lifeMs >= 60_000) {
    return { driverId: session.user.id, usable: true, note: `${Math.round(lifeMs / 1000)}s left` };
  }

  // Only reachable when getSession's own refresh failed. Retry once, explicitly,
  // and surface the reason — a silent failure here is the whole bug.
  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError || !refreshed.session) {
    return {
      driverId: session.user.id,
      usable: false,
      note: `refresh failed: ${refreshError?.message ?? "no session returned"}`,
    };
  }
  return { driverId: refreshed.session.user.id, usable: true, note: "refreshed in task" };
}

export async function startDriverLocationUpdates(
  cadence: Cadence,
  activeRideId: string | null = null,
  driverId: string | null = null,
): Promise<boolean> {
  await setActiveRideId(activeRideId);
  await setPersistedDriverId(driverId);

  // Only foreground permission is requested, on purpose — see the header.
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return false;

  try {
    const already = await Location.hasStartedLocationUpdatesAsync(
      DRIVER_LOCATION_TASK,
    );
    if (already) {
      // Re-registering with new options is how the tier changes; stop first so
      // the service restarts with them rather than keeping the old cadence.
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }
    await Location.startLocationUpdatesAsync(
      DRIVER_LOCATION_TASK,
      taskOptions(cadence),
    );
    return true;
  } catch (e) {
    // Android refuses to START a foreground service from the background
    // (ForegroundServiceStartNotAllowedException). That is the documented
    // ceiling of this design: tracking can only be turned on while the driver
    // has the app open. Fall back to the foreground interval, which the hook
    // keeps running whenever the task isn't.
    console.warn("[Location] could not start background updates:", e);
    return false;
  }
}

export async function stopDriverLocationUpdates(driverId?: string): Promise<void> {
  await setActiveRideId(null);
  await setActiveRoute(null);
  // A shift ending is the one moment buffered fixes would otherwise sit unsent
  // until the next shift — flush before the task stops feeding it.
  if (driverId) await flushBreadcrumbs(driverId);
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(
      DRIVER_LOCATION_TASK,
    );
    if (started) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  } catch (e) {
    console.warn("[Location] could not stop background updates:", e);
  }
}

export async function isDriverLocationRunning(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  } catch {
    return false;
  }
}
