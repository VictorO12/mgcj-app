import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

interface DriverRating {
  average: number | null;   // e.g. 4.8
  count: number;            // total number of ratings
  loading: boolean;
}

/**
 * Fetches the average rating and review count for a driver.
 * Returns null average if there are no reviews yet.
 */
export function useDriverRating(driverId: string | undefined): DriverRating {
  const [average, setAverage] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    fetchRating(driverId);
  }, [driverId]);

  async function fetchRating(id: string) {
    setLoading(true);
    const { data, error } = await supabase
      .from("ride_reviews")
      .select("rating")
      .eq("driver_id", id);

    if (error || !data || data.length === 0) {
      setAverage(null);
      setCount(0);
    } else {
      const sum = data.reduce((acc, r) => acc + r.rating, 0);
      setAverage(Math.round((sum / data.length) * 10) / 10); // 1 decimal
      setCount(data.length);
    }
    setLoading(false);
  }

  return { average, count, loading };
}