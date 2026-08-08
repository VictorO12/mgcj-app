import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { supabase } from "../lib/supabase";

// Keeps writing the driver's current_lat/current_lng every 10s while online,
// independent of which driver screen is currently mounted. DriverHomeScreen
// used to own this interval, but DriverApp unmounts it whenever an assigned
// ride or active ride screen is shown — silently stopping location updates
// (and passenger ETA) for the whole assigned/driver_arriving window.
/**
 * A GPS course worth broadcasting, or null. See the call site for why speed is
 * part of the test.
 */
function courseOrNull(coords: Location.LocationObjectCoords): number | null {
  const { heading, speed } = coords;
  if (heading == null || heading < 0) return null;
  if (speed == null || speed < 1) return null;
  return heading;
}

export function useDriverLocationBroadcast(driverId: string | undefined) {
  const [isOnline, setIsOnline] = useState(false);
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (locationInterval.current) clearInterval(locationInterval.current);
    if (!isOnline || !driverId) return;
    locationInterval.current = setInterval(async () => {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await supabase
        .from("drivers")
        .update({
          current_lat: loc.coords.latitude,
          current_lng: loc.coords.longitude,
          // GPS course, for the directional car icon on the passenger map.
          // Gated on speed, not just on the iOS -1 sentinel: Android's
          // Location.getBearing() returns a plain 0.0 when it has no bearing,
          // which would pass a `>= 0` check and point every parked car due
          // north. Below ~1 m/s (and this is a one-shot fix, so course is
          // often absent anyway) write null and let the passenger client
          // derive the bearing from position deltas instead.
          heading: courseOrNull(loc.coords),
          updated_at: new Date().toISOString(),
          // Liveness heartbeat. Dispatch treats a driver whose last_seen_at is
          // >60s stale as offline (phantom), and a nightly-ish reaper flips them
          // offline after 5 min. This interval only ticks while foregrounded, so
          // closing/backgrounding the app naturally lets the beat go stale.
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", driverId);
    }, 10000);
    return () => {
      if (locationInterval.current) clearInterval(locationInterval.current);
    };
  }, [isOnline, driverId]);
}
