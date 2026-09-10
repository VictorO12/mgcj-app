import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { getDeviceToken } from "./deviceSession";
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

const CADENCE: Record<Cadence, Location.LocationTaskOptions> = {
  idle: {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 150,
    timeInterval: 60_000,
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
      // Keeps the service alive across the app being swiped away, which is the
      // difference between "the driver locked their phone" and "dispatch lost
      // them". It cannot survive a force-stop or a reboot — see the note.
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

// The driver id the task should write for. The task body runs in a JS context
// the OS may have relaunched headlessly, with no React tree and no props, so
// the id cannot come from a hook — it is stashed here when the task starts and
// re-read from the session if this module was freshly loaded.
let taskDriverId: string | null = null;

// Defined at module scope, imported for its side effect from App.tsx. If a
// headless relaunch delivers a batch before the task name is registered, the
// batch is dropped and the only trace is a warning nobody sees on a device.
TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn("[Location] task error:", error.message);
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations;
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  // A batch can arrive after hours of background, and supabase.ts stops the
  // auto-refresh loop while backgrounded — so the persisted access token is
  // very likely expired by now. getSession() awaits restore-from-storage but
  // does NOT necessarily refresh, and the drivers UPDATE policy is
  // `id = auth.uid()`, so writing on a dead token is a silent 401 in a context
  // with no UI to surface it.
  const driverId = await resolveDriverId();
  if (!driverId) return;

  const result = await writeDriverPosition(driverId, latest.coords);
  if (result === "displaced") {
    // Another device owns this account now. A device that lost the lock must
    // not keep writing position — dispatch would see two cars for one driver.
    console.warn("[Location] displaced — stopping background updates");
    await stopDriverLocationUpdates();
  }
});

async function resolveDriverId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    console.warn("[Location] no session in task context — skipping fix");
    return null;
  }
  const expiresAt = data.session.expires_at ?? 0;
  if (expiresAt * 1000 - Date.now() < 60_000) {
    const { data: refreshed, error: refreshError } =
      await supabase.auth.refreshSession();
    if (refreshError || !refreshed.session) {
      console.warn("[Location] could not refresh session in task — skipping fix");
      return null;
    }
    taskDriverId = refreshed.session.user.id;
    return taskDriverId;
  }
  taskDriverId = data.session.user.id;
  return taskDriverId;
}

export async function startDriverLocationUpdates(
  driverId: string,
  cadence: Cadence,
): Promise<boolean> {
  taskDriverId = driverId;

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

export async function stopDriverLocationUpdates(): Promise<void> {
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
