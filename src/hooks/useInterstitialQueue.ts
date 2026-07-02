import { useState, useEffect, useCallback } from "react";
import { AppState } from "react-native";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export interface InterstitialMessage {
  id: string;
  category: "announcement" | "offer";
  title: string;
  body: string;
  image_url: string | null;
  expires_at: string | null;
  created_at: string;
}

// gateOpen = "safe to interrupt right now" (idle home screen, no active ride, not mid-booking).
// Candidates keep accumulating in the background regardless of the gate; `current` only
// surfaces the oldest one while the gate is open, so nothing pops mid-ride or mid-booking.
export function useInterstitialQueue(gateOpen: boolean) {
  const { profile } = useAuth();
  const [queue, setQueue] = useState<InterstitialMessage[]>([]);
  const targetType = profile?.role === "driver" ? "all_drivers" : "all_passengers";

  const fetchQueue = useCallback(async () => {
    if (!profile?.company_id) return;
    const { data: rows } = await supabase
      .from("messages")
      .select("id, category, title, body, image_url, expires_at, created_at")
      .eq("target_type", targetType)
      .eq("display_mode", "interstitial")
      .eq("company_id", profile.company_id)
      .gte("created_at", profile.created_at)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: true });

    if (!rows || rows.length === 0) {
      setQueue([]);
      return;
    }

    const { data: reads } = await supabase
      .from("message_reads")
      .select("message_id")
      .eq("profile_id", profile.id)
      .in("message_id", rows.map((r) => r.id));

    const readSet = new Set((reads ?? []).map((r) => r.message_id));
    setQueue(rows.filter((r) => !readSet.has(r.id)));
  }, [profile, targetType]);

  useEffect(() => {
    if (gateOpen) fetchQueue();
  }, [gateOpen, fetchQueue]);

  useEffect(() => {
    if (!profile?.company_id) return;
    const channel = supabase
      .channel("broadcast-interstitial-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `company_id=eq.${profile.company_id}`,
        },
        (payload) => {
          const row = payload.new as any;
          if (row.target_type === targetType && row.display_mode === "interstitial") {
            setQueue((prev) => [...prev, row]);
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile, targetType]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && gateOpen) fetchQueue();
    });
    return () => sub.remove();
  }, [gateOpen, fetchQueue]);

  const current = gateOpen ? (queue[0] ?? null) : null;

  const dismiss = useCallback(async () => {
    if (!current || !profile) return;
    const id = current.id;
    setQueue((prev) => prev.filter((m) => m.id !== id));
    await supabase
      .from("message_reads")
      .upsert([{ message_id: id, profile_id: profile.id }], {
        onConflict: "message_id,profile_id",
        ignoreDuplicates: true,
      });
  }, [current, profile]);

  return { current, dismiss };
}
