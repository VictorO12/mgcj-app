import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import {
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
const HEARTBEAT_MS = 10_000;

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
      void stopDriverLocationUpdates();
      return;
    }
    void startDriverLocationUpdates(tier);
    // No cleanup-stop here: this effect re-runs on every cadence change, and
    // tearing the service down between tiers would drop fixes mid-fare. Going
    // offline is the only thing that stops it, handled by the branch above.
  }, [driverId, isOnline, tier]);

  // Stop tracking if the driver signs out or this hook unmounts for good — the
  // service outliving the session would keep writing for a driver who is gone.
  useEffect(() => {
    return () => { void stopDriverLocationUpdates(); };
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
      const result = await writeDriverPosition(driverId, coords);
      if (result === "displaced") {
        console.warn("[Session] heartbeat rejected — device_token no longer ours");
        onDisplacedRef.current?.();
      }
    }, HEARTBEAT_MS);
    return () => {
      if (heartbeat.current) clearInterval(heartbeat.current);
    };
  }, [isOnline, driverId]);
}
