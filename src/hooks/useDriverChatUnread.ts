import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export function useDriverChatUnread() {
  const { profile } = useAuth();
  const [hasUnread, setHasUnread] = useState(false);

  const refetch = useCallback(async () => {
    if (!profile || profile.role !== "driver") return;
    const { data: state } = await supabase
      .from("driver_chat_state")
      .select("last_read_by_driver_at")
      .eq("driver_id", profile.id)
      .maybeSingle();
    const lastRead = state?.last_read_by_driver_at ?? "1970-01-01";

    const { count } = await supabase
      .from("driver_chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", profile.id)
      .eq("sender_role", "admin")
      .gt("created_at", lastRead);

    setHasUnread((count ?? 0) > 0);
  }, [profile]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!profile || profile.role !== "driver") return;
    const channel = supabase
      .channel("driver-chat-badge-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "driver_chat_messages",
          filter: `driver_id=eq.${profile.id}`,
        },
        (payload) => {
          if ((payload.new as any).sender_role === "admin") setHasUnread(true);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  return { hasUnread, refetch };
}
