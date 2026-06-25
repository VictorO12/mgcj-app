import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { supabase } from "../lib/supabase";

// Keeps writing the driver's current_lat/current_lng every 10s while online,
// independent of which driver screen is currently mounted. DriverHomeScreen
// used to own this interval, but DriverApp unmounts it whenever an assigned
// ride or active ride screen is shown — silently stopping location updates
// (and passenger ETA) for the whole assigned/driver_arriving window.
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
          updated_at: new Date().toISOString(),
        })
        .eq("id", driverId);
    }, 10000);
    return () => {
      if (locationInterval.current) clearInterval(locationInterval.current);
    };
  }, [isOnline, driverId]);
}
