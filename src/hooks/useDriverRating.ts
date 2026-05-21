import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";

interface DriverRating {
  average: number | null;
  count: number;
  loading: boolean;
}

export function useDriverRating(driverId: string | undefined): DriverRating {
  const [average, setAverage] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchRating = useCallback(async () => {
    if (!driverId) return;
    const { data } = await supabase
      .from("ride_reviews")
      .select("rating")
      .eq("driver_id", driverId);

    if (!data || data.length === 0) {
      setAverage(null);
      setCount(0);
    } else {
      const sum = data.reduce((acc, r) => acc + r.rating, 0);
      setAverage(Math.round((sum / data.length) * 10) / 10);
      setCount(data.length);
    }
    setLoading(false);
  }, [driverId]);

  useEffect(() => {
    if (!driverId) { setLoading(false); return; }

    fetchRating();

    const channel = supabase
      .channel("rating-" + driverId)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ride_reviews",
          filter: `driver_id=eq.${driverId}`,
        },
        (payload) => {
          console.log("[useDriverRating] realtime fired", payload);
          fetchRating();
        }
      )
      .subscribe((status) => {
        console.log("[useDriverRating] subscription status:", status);
      });

    return () => { supabase.removeChannel(channel); };
  }, [driverId, fetchRating]);

  return { average, count, loading };
}