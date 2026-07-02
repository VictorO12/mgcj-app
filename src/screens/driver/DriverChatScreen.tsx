import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface ChatMessage {
  id: string;
  sender_role: "admin" | "driver";
  body: string;
  created_at: string;
}

interface Props {
  onClose: () => void;
}

export default function DriverChatScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    fetchThread();
  }, [profile]);

  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("driver-chat-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "driver_chat_messages",
          filter: `driver_id=eq.${profile.id}`,
        },
        (payload) => {
          const row = payload.new as ChatMessage;
          setMessages((prev) => [...prev, row]);
          if (row.sender_role === "admin") markRead();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  const hasScrolledInitialRef = useRef(false);
  useEffect(() => {
    // Guard on `loading` too: setMessages fires before the awaited markRead()
    // resolves and flips loading false, so a plain [messages] dependency fires
    // while the ScrollView isn't mounted yet and never fires again once it is.
    if (loading) return;
    scrollRef.current?.scrollToEnd({ animated: hasScrolledInitialRef.current });
    hasScrolledInitialRef.current = true;
  }, [messages, loading]);

  async function fetchThread() {
    if (!profile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await supabase
        .from("driver_chat_messages")
        .select("id, sender_role, body, created_at")
        .eq("driver_id", profile.id)
        .order("created_at", { ascending: true })
        .limit(300);
      setMessages(data ?? []);
      await markRead();
    } finally {
      setLoading(false);
    }
  }

  async function markRead() {
    if (!profile?.company_id) return;
    await supabase
      .from("driver_chat_state")
      .upsert(
        {
          driver_id: profile.id,
          company_id: profile.company_id,
          last_read_by_driver_at: new Date().toISOString(),
        },
        { onConflict: "driver_id" },
      );
  }

  const sendMessage = useCallback(async () => {
    if (!profile?.company_id || !draft.trim()) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");
    try {
      await supabase.from("driver_chat_messages").insert({
        company_id: profile.company_id,
        driver_id: profile.id,
        sender_id: profile.id,
        sender_role: "driver",
        body,
      });
    } finally {
      setSending(false);
    }
  }, [profile, draft]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Dispatch</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.accentOrange} />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 ? (
            <View style={styles.centerFill}>
              <Ionicons name="chatbubble-outline" size={36} color={colors.textFaint} />
              <Text style={styles.emptyText}>No messages yet</Text>
            </View>
          ) : (
            messages.map((m) => {
              const isDriver = m.sender_role === "driver";
              return (
                <View
                  key={m.id}
                  style={[styles.bubbleRow, isDriver ? styles.bubbleRowRight : styles.bubbleRowLeft]}
                >
                  <View style={[styles.bubble, isDriver ? styles.bubbleDriver : styles.bubbleAdmin]}>
                    <Text style={styles.bubbleText}>{m.body}</Text>
                  </View>
                  <Text style={[styles.bubbleTime, isDriver && styles.bubbleTimeRight]}>
                    {new Date(m.created_at).toLocaleTimeString("en-CA", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Type a message..."
          placeholderTextColor={colors.textFaint}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!draft.trim() || sending) && styles.sendBtnDisabled]}
          disabled={!draft.trim() || sending}
          onPress={sendMessage}
        >
          <Ionicons name="arrow-up" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingHorizontal: 20,
      paddingBottom: 16,
      backgroundColor: colors.backgroundOverlay,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    backBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
    centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 60 },
    emptyText: { fontSize: 14, color: colors.textSecondary },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 20, flexGrow: 1 },
    bubbleRow: { marginBottom: 12, maxWidth: "78%" },
    bubbleRowLeft: { alignSelf: "flex-start" },
    bubbleRowRight: { alignSelf: "flex-end" },
    bubble: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 14 },
    bubbleAdmin: {
      backgroundColor: colors.surface,
      borderBottomLeftRadius: 4,
    },
    bubbleDriver: {
      backgroundColor: "rgba(232,80,10,0.16)",
      borderBottomRightRadius: 4,
    },
    bubbleText: { fontSize: 14, color: colors.textPrimary, lineHeight: 19 },
    bubbleTime: { fontSize: 10, color: colors.textFaint, marginTop: 3 },
    bubbleTimeRight: { textAlign: "right" },
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 10,
      padding: 14,
      paddingBottom: Platform.OS === "ios" ? 28 : 14,
      borderTopWidth: 0.5,
      borderTopColor: colors.border,
      backgroundColor: colors.backgroundOverlay,
    },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      color: colors.textPrimary,
      fontSize: 14,
      maxHeight: 100,
    },
    sendBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
  });
