import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export function useInboxUnreadCount() {
  const { profile } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const targetType = profile?.role === "driver" ? "all_drivers" : "all_passengers";

  const refetch = useCallback(async () => {
    if (!profile?.company_id) return;
    const { data: rows } = await supabase
      .from("messages")
      .select("id")
      .eq("target_type", targetType)
      .eq("company_id", profile.company_id)
      .gte("created_at", profile.created_at)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

    if (!rows || rows.length === 0) {
      setUnreadCount(0);
      return;
    }

    const { data: reads } = await supabase
      .from("message_reads")
      .select("message_id")
      .eq("profile_id", profile.id)
      .in("message_id", rows.map((r) => r.id));

    const readSet = new Set((reads ?? []).map((r) => r.message_id));
    setUnreadCount(rows.filter((r) => !readSet.has(r.id)).length);
  }, [profile, targetType]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!profile?.company_id) return;
    const channel = supabase
      .channel("broadcast-inbox-badge-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `company_id=eq.${profile.company_id}`,
        },
        (payload) => {
          if ((payload.new as any).target_type === targetType) {
            setUnreadCount((prev) => prev + 1);
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile, targetType]);

  return { unreadCount, refetch };
}
