import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export type RideMessageKind = "text" | "quick_reply" | "ack";

export interface RideMessage {
  id: string;
  ride_id: string;
  sender_id: string | null;
  sender_role: "passenger" | "driver" | "admin" | "dispatcher";
  body: string;
  kind: RideMessageKind;
  created_at: string;
}

// Statuses in which the INSERT policy will accept a message. Mirrors
// ride_accepts_messages() in 20260754_ride_messages.sql -- kept here so the UI
// can disable the composer with an explanation rather than letting the insert
// fail with an opaque RLS error the passenger cannot act on. If that function's
// status list changes, change this too; nothing enforces the pairing.
export const CHATTABLE_STATUSES = ["assigned", "driver_arriving", "in_progress"];

/**
 * The passenger <-> driver thread for one ride.
 *
 * TRANSPORT IS DELIBERATELY ISOLATED TO subscribe() BELOW. ride_messages uses
 * Supabase Broadcast rather than postgres_changes, so that the highest-write
 * table in the system is not added to the supabase_realtime publication next
 * to `rides` (see section 6 of the migration). Broadcast authorization has no
 * precedent in this repo, so if the spike in
 * .claude/notes/g3-broadcast-auth-spike.sql shows realtime.topic() is missing,
 * the fallback is a postgres_changes subscription with a ride_id=eq.X filter
 * and ONLY the marked block below changes. Everything else in Phase 1 --
 * schema, policies, push, both screens -- is transport-agnostic.
 *
 * Note the fallback is not free: it requires ALTER PUBLICATION on
 * ride_messages, which is exactly what the Broadcast choice avoids. Treat it
 * as a decision, not an automatic swap.
 */
export function useRideThread(rideId: string | null | undefined) {
  const { profile } = useAuth();
  const [messages, setMessages] = useState<RideMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  // Broadcast delivers our own inserts back to us, and a reconnect refetch can
  // race a live message. Dedupe by id on the way in rather than trying to make
  // either path exclusive.
  const appendMessage = useCallback((row: RideMessage) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === row.id)) return prev;
      return [...prev, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }, []);

  const fetchThread = useCallback(async () => {
    if (!rideId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("ride_messages")
      .select("id, ride_id, sender_id, sender_role, body, kind, created_at")
      .eq("ride_id", rideId)
      .order("created_at", { ascending: true })
      .limit(300);
    setMessages(data ?? []);
    setLoading(false);
  }, [rideId]);

  useEffect(() => {
    setLoading(true);
    fetchThread();
  }, [fetchThread]);

  useEffect(() => {
    if (!rideId || !profile) return;

    // ── TRANSPORT (the one block the postgres_changes fallback replaces) ──
    // The topic is the authorization key: the policy on realtime.messages
    // parses the ride id back out of this exact string, so `ride:<uuid>` is a
    // contract with can_read_ride_topic(), not a display name.
    const channel = supabase
      .channel(`ride:${rideId}`, { config: { private: true } })
      .on("broadcast", { event: "new_message" }, ({ payload }) => {
        appendMessage(payload as RideMessage);
      })
      .subscribe((status) => {
        // Broadcast has no replay, so anything sent while we were away is
        // simply gone from the socket's point of view. Refetch on every
        // (re)connect to close that window -- the table is the durable record.
        if (status === "SUBSCRIBED") fetchThread();
        // An unauthorized private channel fails LOUDLY here but SILENTLY
        // everywhere else: no error is thrown, messages just never arrive.
        // This log is the difference between a five-minute diagnosis and an
        // afternoon of one.
        if (status === "CHANNEL_ERROR") {
          console.warn(
            `[useRideThread] private channel rejected for ride:${rideId} — ` +
              `check the ride_thread_broadcast_read policy on realtime.messages`,
          );
        }
      });
    // ── END TRANSPORT ────────────────────────────────────────────────────

    return () => {
      supabase.removeChannel(channel);
    };
  }, [rideId, profile, appendMessage, fetchThread]);

  const send = useCallback(
    async (body: string, kind: RideMessageKind = "text") => {
      if (!rideId || !profile) return { error: "not ready" };
      const trimmed = body.trim();
      if (!trimmed) return { error: "empty" };

      // sender_role is checked against the ride by the INSERT policy, so
      // sending the wrong one is rejected rather than mis-attributed. Derived
      // from the profile rather than passed in, so no call site can get it
      // wrong.
      const senderRole = profile.role === "driver" ? "driver" : "passenger";

      const { error } = await supabase.from("ride_messages").insert({
        ride_id: rideId,
        sender_id: profile.id,
        sender_role: senderRole,
        body: trimmed,
        kind,
      });
      // company_id is stamped by a BEFORE INSERT trigger, not sent from here.
      if (error) console.warn("[useRideThread] send failed:", error.message);
      return { error: error?.message ?? null };
    },
    [rideId, profile],
  );

  const markRead = useCallback(async () => {
    if (!rideId || !profile) return;
    const now = new Date().toISOString();
    await supabase.from("ride_chat_reads").upsert(
      { ride_id: rideId, profile_id: profile.id, last_read_at: now },
      { onConflict: "ride_id,profile_id" },
    );
    // Advance the local cursor too, not just the count: without this the next
    // inbound message recomputes against the session-start cursor and counts
    // everything already read.
    setLastReadAt(now);
    setUnreadCount(0);
  }, [rideId, profile]);

  // The read cursor is STATE, not a ref, and that is load-bearing twice over.
  // As a ref it does not participate in the recompute below, which broke the
  // badge in two ways: on a cold open the cursor fetch races the message
  // fetch, and if messages landed first the recompute bailed on a null cursor
  // and nothing ever re-triggered it (a ref assignment causes no render) — so
  // the badge read zero with unread messages sitting there, about half the
  // time. And after markRead the cursor never advanced, so every later message
  // recounted the ones already read: the badge would creep toward the running
  // total instead of the new count. That is precisely the failure the ride
  // digest was designed around, arriving through a different door.
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);

  useEffect(() => {
    if (!rideId || !profile) {
      setLastReadAt(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("ride_chat_reads")
        .select("last_read_at")
        .eq("ride_id", rideId)
        .eq("profile_id", profile.id)
        .maybeSingle();
      if (!cancelled) setLastReadAt(data?.last_read_at ?? "1970-01-01");
    })();
    return () => {
      cancelled = true;
    };
  }, [rideId, profile]);

  useEffect(() => {
    if (!profile || lastReadAt === null) return;
    setUnreadCount(
      messages.filter((m) => m.sender_id !== profile.id && m.created_at > lastReadAt).length,
    );
  }, [messages, profile, lastReadAt]);

  return { messages, loading, unreadCount, send, markRead, refetch: fetchThread };
}
