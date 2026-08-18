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
import * as Speech from "expo-speech";
import { useAuth } from "../../hooks/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";
import { useRideThread, CHATTABLE_STATUSES, type RideMessage } from "../../hooks/useRideThread";

export type RideThread = ReturnType<typeof useRideThread>;

interface Props {
  // The thread is OWNED BY THE HOST SCREEN and passed in, not created here.
  // The host needs the unread count for its badge while this screen is closed,
  // and two useRideThread instances would mean two subscriptions to the same
  // private channel — supabase-js keys channels by topic, so the second one
  // fights the first rather than doubling up harmlessly.
  thread: RideThread;
  // The ride's live status, so the composer can explain itself rather than
  // letting an insert bounce off the RLS policy with an opaque error.
  rideStatus: string;
  // Who the OTHER side is, for the header. Not read from the thread: a ride
  // can have zero messages and still needs a title.
  counterpartName?: string | null;
  onClose: () => void;
}

// Quick replies exist because the alternative is a driver typing at the wheel.
// They are not polish -- they are the safety half of this feature, and the
// reason `kind` is stored: "the driver never typed while moving" has to be
// auditable later.
const DRIVER_QUICK_REPLIES = [
  "On my way",
  "I'm outside",
  "Running a few minutes late",
  "I can't find the pickup spot",
];

const PASSENGER_QUICK_REPLIES = [
  "Coming out now",
  "Be there in 2 minutes",
  "I'm at the front entrance",
  "Please wait a moment",
];

function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.round(
    (new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-CA", { month: "long", day: "numeric" });
}

export default function RideChatScreen({ thread, rideStatus, counterpartName, onClose }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { messages, loading, send, markRead } = thread;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const isDriver = profile?.role === "driver";
  const quickReplies = isDriver ? DRIVER_QUICK_REPLIES : PASSENGER_QUICK_REPLIES;
  const canSend = CHATTABLE_STATUSES.includes(rideStatus);

  // On open, and again on close. NOT once per inbound message: that was an
  // upsert per message, and it is unnecessary now that markRead advances the
  // local cursor -- a thread being actively watched shows no badge because the
  // count is maintained in memory, and the write only has to be durable by the
  // time the screen goes away.
  useEffect(() => {
    markRead();
    return () => {
      markRead();
    };
  }, [markRead]);

  const hasScrolledInitialRef = useRef(false);
  useEffect(() => {
    // Guard on `loading` too: the first setMessages lands before loading flips
    // false, so a plain [messages] dependency fires while the ScrollView is
    // not mounted and never fires again once it is. Same trap as
    // DriverChatScreen.
    if (loading) return;
    scrollRef.current?.scrollToEnd({ animated: hasScrolledInitialRef.current });
    hasScrolledInitialRef.current = true;
  }, [messages, loading]);

  // Read-aloud is driver-only and manual. NOT automatic: a phone that starts
  // talking on its own mid-fare is worse than a notification, and the driver
  // may have a passenger in the car who should not hear the thread read out.
  const speakLatest = useCallback(() => {
    const incoming = [...messages].reverse().find((m) => m.sender_id !== profile?.id);
    if (!incoming) return;
    if (speaking) {
      Speech.stop();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    Speech.speak(incoming.body, {
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  }, [messages, profile, speaking]);

  useEffect(() => {
    // Leaving the screen must not leave the phone talking.
    return () => {
      Speech.stop();
    };
  }, []);

  const doSend = useCallback(
    async (body: string, kind: "text" | "quick_reply" | "ack") => {
      if (sending || !canSend) return;
      setSending(true);
      // Clear the composer optimistically only for typed text -- a failed
      // quick reply has nothing to restore, but a passenger who typed three
      // sentences should not lose them to a dropped connection.
      const previousDraft = draft;
      if (kind === "text") setDraft("");
      const { error } = await send(body, kind);
      if (error && kind === "text") setDraft(previousDraft);
      setSending(false);
    },
    [send, sending, canSend, draft],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {counterpartName || (isDriver ? "Passenger" : "Your driver")}
        </Text>
        {isDriver ? (
          <TouchableOpacity style={styles.backBtn} onPress={speakLatest}>
            <Ionicons
              name={speaking ? "stop-circle-outline" : "volume-high-outline"}
              size={22}
              color={speaking ? colors.accentOrange : colors.textSecondary}
            />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 40 }} />
        )}
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
              <Text style={styles.emptyText}>
                {isDriver
                  ? "Message your passenger about the pickup"
                  : "Message your driver about the pickup"}
              </Text>
            </View>
          ) : (
            messages.map((m: RideMessage, i: number) => {
              const isMine = m.sender_id === profile?.id;
              const showSeparator =
                i === 0 || dayKey(m.created_at) !== dayKey(messages[i - 1].created_at);
              return (
                <React.Fragment key={m.id}>
                  {showSeparator && (
                    <View style={styles.dateSep}>
                      <Text style={styles.dateSepText}>{formatDateLabel(m.created_at)}</Text>
                    </View>
                  )}
                  <View
                    style={[styles.bubbleRow, isMine ? styles.bubbleRowRight : styles.bubbleRowLeft]}
                  >
                    <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                      <Text style={styles.bubbleText}>{m.body}</Text>
                    </View>
                    <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeRight]}>
                      {new Date(m.created_at).toLocaleTimeString("en-CA", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </Text>
                  </View>
                </React.Fragment>
              );
            })
          )}
        </ScrollView>
      )}

      {canSend ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.quickRow}
            contentContainerStyle={styles.quickRowContent}
            keyboardShouldPersistTaps="handled"
          >
            <TouchableOpacity
              style={styles.ackChip}
              disabled={sending}
              onPress={() => doSend("👍", "ack")}
            >
              <Text style={styles.ackChipText}>👍</Text>
            </TouchableOpacity>
            {quickReplies.map((q) => (
              <TouchableOpacity
                key={q}
                style={styles.quickChip}
                disabled={sending}
                onPress={() => doSend(q, "quick_reply")}
              >
                <Text style={styles.quickChipText}>{q}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

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
              onPress={() => doSend(draft, "text")}
            >
              <Ionicons name="send" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </>
      ) : (
        // The thread stays readable forever -- it is the record if the ride is
        // later disputed -- but only a live ride accepts new messages. Saying
        // so beats a send button that silently fails.
        <View style={styles.closedNotice}>
          <Ionicons name="lock-closed-outline" size={15} color={colors.textSecondary} />
          <Text style={styles.closedNoticeText}>
            This ride has ended. Messages are closed, but the conversation stays here.
          </Text>
        </View>
      )}
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
      paddingBottom: 14,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backBtn: { width: 40, alignItems: "center", justifyContent: "center" },
    headerTitle: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600", color: colors.textPrimary },
    centerFill: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 },
    emptyText: { marginTop: 10, color: colors.textSecondary, fontSize: 14, textAlign: "center", paddingHorizontal: 40 },
    scroll: { flex: 1 },
    scrollContent: { paddingVertical: 14, paddingHorizontal: 14, flexGrow: 1 },
    dateSep: { alignItems: "center", marginVertical: 12 },
    dateSepText: { fontSize: 12, color: colors.textSecondary },
    bubbleRow: { marginBottom: 10, maxWidth: "82%" },
    bubbleRowLeft: { alignSelf: "flex-start" },
    bubbleRowRight: { alignSelf: "flex-end" },
    bubble: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16 },
    bubbleMine: { backgroundColor: colors.accentOrange, borderBottomRightRadius: 4 },
    bubbleTheirs: { backgroundColor: colors.surface, borderBottomLeftRadius: 4 },
    bubbleText: { fontSize: 15, color: colors.textPrimary, lineHeight: 20 },
    bubbleTime: { fontSize: 11, color: colors.textSecondary, marginTop: 3, marginHorizontal: 4 },
    bubbleTimeRight: { textAlign: "right" },
    quickRow: { maxHeight: 46, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
    quickRowContent: { paddingHorizontal: 10, paddingVertical: 7, gap: 7, alignItems: "center" },
    quickChip: {
      paddingHorizontal: 13,
      paddingVertical: 7,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    quickChipText: { fontSize: 13, color: colors.textPrimary },
    ackChip: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    ackChipText: { fontSize: 16 },
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: Platform.OS === "ios" ? 28 : 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 8,
    },
    input: {
      flex: 1,
      maxHeight: 110,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      borderRadius: 20,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      fontSize: 15,
    },
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtnDisabled: { opacity: 0.4 },
    closedNotice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: Platform.OS === "ios" ? 30 : 14,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    closedNoticeText: { flex: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  });
