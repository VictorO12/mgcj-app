import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { recordFix } from "../lib/breadcrumbs";
import { getDistance } from "../lib/routeProgress";
import {
  courseOrNull,
  isDriverLocationRunning,
  startDriverLocationUpdates,
  stopDriverLocationUpdates,
  writeDriverPosition,
} from "../lib/driverLocation";
import { supabase } from "../lib/supabase";

// Keeps the driver's position and liveness beat flowing while they are online,
// independent of which driver screen is currently mounted. DriverHomeScreen
// used to own this interval, but DriverApp unmounts it whenever an assigned
// ride or active ride screen is shown — silently stopping location updates
// (and passenger ETA) for the whole assigned/driver_arriving window.
//
// TWO WRITERS, deliberately, because they answer different questions:
//
//   background task (src/lib/driverLocation.ts) — WHERE the driver is. Distance
//     triggered while idle, time triggered during a fare. Survives the app
//     being backgrounded, which is the whole point.
//
//   this interval — WHETHER the driver is still there. A time-based touch of
//     last_seen_at that needs no GPS fix at all. Conflating the two is what
//     makes a parked driver look dead: a distance trigger correctly emits
//     nothing when nobody moves, so liveness cannot ride on it.
//
// Known gap, accepted for now: JS timers do not run while backgrounded, so an
// iOS driver who is backgrounded AND stationary stops beating until they move
// (Android keeps beating on the foreground service's timeInterval). Dispatch
// RANKS on liveness rather than filtering, so the cost is offer priority, not
// a missed ride — and the reaper sits at 4h. Revisit with real shift data.
// 20s, not 10s (raised 2026-09-10). Every beat is a PATCH on `drivers`, which
// the dispatch dashboard subscribes to with `event: "*"` — so one beat is a
// row write, a WAL record, a realtime decode, and a broadcast to every open
// dispatch tab. At 10s that is 6 writes/minute per driver before anyone has
// moved, and it was a measurable share of the load that exhausted the
// free-tier CPU credits.
//
// 20s is still THREE beats inside PRESENCE_STALE_MS (60s), so a driver has to
// miss three in a row before dispatch reads them as away — the same tolerance
// for a network blip the 10s value had at six.
//
// This only reduces the symptom. The real fix is that a 10-second liveness
// beat does not belong in a replicated table at all: the cost is
// O(drivers x dashboards), so it gets worse with fleet size AND with the
// number of dispatchers watching. See the DB-load note.
const HEARTBEAT_MS = 20_000;

export function useDriverLocationBroadcast(
  driverId: string | undefined,
  onDisplaced?: () => void,
  /** Set while this driver is on an active ride — escalates the cadence tier. */
  activeRideId?: string | null,
) {
  const [isOnline, setIsOnline] = useState(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  // Kept in a ref so the interval below never has to be torn down and rebuilt
  // just because the callback identity changed on a re-render.
  const onDisplacedRef = useRef(onDisplaced);
  onDisplacedRef.current = onDisplaced;
  // The unmount cleanup below runs with an empty dep list so it can't close over
  // a live driverId; a ref gives it the current one without re-running.
  const driverIdRef = useRef(driverId);
  driverIdRef.current = driverId;
  // Last position filed as a breadcrumb on the FALLBACK path. That path fixes
  // position every 10s whether or not the car has moved, so without this a
  // parked driver files ~8,600 identical rows a day — noise in the history, and
  // it muddies driver_has_moved(), which asks whether a shift is still being
  // worked. The background task needs no equivalent: its idle tier is distance
  // triggered, so a stationary car emits nothing by construction.
  const lastCrumb = useRef<{ latitude: number; longitude: number } | null>(null);

  useEffect(() => {
    if (!driverId) return;
    supabase
      .from("drivers")
      .select("is_active")
      .eq("id", driverId)
      .single()
      .then(({ data }) => {
        if (data) setIsOnline(data.is_active);
      });

    const channel = supabase
      .channel("driver-online-" + driverId)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "drivers", filter: "id=eq." + driverId },
        (payload) => setIsOnline(Boolean((payload.new as any).is_active)),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [driverId]);

  // Background location: on while online, off the moment they go offline. The
  // cadence tier is part of the dependency list so starting a ride restarts the
  // service with the tighter settings.
  // Derived, and depended on instead of activeRideId: back-to-back fares
  // (ride A ends, ride B starts) change the id but not the tier, and
  // restarting the service between them would drop fixes for no gain.
  const tier = activeRideId ? "ride" : "idle";

  useEffect(() => {
    if (!driverId) return;
    if (!isOnline) {
      void stopDriverLocationUpdates(driverId);
      return;
    }
    void startDriverLocationUpdates(tier, activeRideId ?? null, driverId);
    // No cleanup-stop here: this effect re-runs on every cadence change, and
    // tearing the service down between tiers would drop fixes mid-fare. Going
    // offline is the only thing that stops it, handled by the branch above.
  }, [driverId, isOnline, tier]);

  // Stop tracking if the driver signs out or this hook unmounts for good — the
  // service outliving the session would keep writing for a driver who is gone.
  useEffect(() => {
    return () => { void stopDriverLocationUpdates(driverIdRef.current); };
  }, []);

  useEffect(() => {
    if (heartbeat.current) clearInterval(heartbeat.current);
    if (!isOnline || !driverId) return;
    heartbeat.current = setInterval(async () => {
      // The background task owns position while it is running, so the beat is
      // a pure last_seen_at touch — no GPS fix, no duplicate write. If the task
      // failed to start (permission denied, or Android refusing to start a
      // foreground service), fall back to fixing position here so an older or
      // stricter device still shows up on the dispatch map.
      let coords = null;
      if (!(await isDriverLocationRunning())) {
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          coords = loc.coords;
        } catch {
          // No fix available this tick; still send the beat.
        }
      }
      const movedEnough =
        coords != null &&
        (lastCrumb.current == null ||
          getDistance(lastCrumb.current, {
            latitude: coords.latitude,
            longitude: coords.longitude,
          }) >= 50);
      if (coords && movedEnough) {
        lastCrumb.current = {
          latitude: coords.latitude,
          longitude: coords.longitude,
        };
        // Fallback path only: the task normally owns history. Without this a
        // device that could not start the background service would show a live
        // dot and an empty trail.
        await recordFix(driverId, {
          recorded_at: new Date().toISOString(),
          lat: coords.latitude,
          lng: coords.longitude,
          heading: courseOrNull(coords),
          speed: coords.speed ?? null,
          accuracy: coords.accuracy ?? null,
          ride_id: activeRideId ?? null,
        });
      }
      const result = await writeDriverPosition(driverId, coords);
      if (result === "displaced") {
        console.warn("[Session] heartbeat rejected — device_token no longer ours");
        onDisplacedRef.current?.();
      }
    }, HEARTBEAT_MS);
    return () => {
      if (heartbeat.current) clearInterval(heartbeat.current);
    };
  }, [isOnline, driverId, activeRideId]);
}
