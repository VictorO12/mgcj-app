import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

interface Props {
  visible: boolean;
  rideId: string;
  /** Ride status, so the copy matches what the passenger is actually looking at. */
  status: string;
  /**
   * Reasons already sent for the current unresolved escalation. Shown ticked
   * and locked, so a passenger adding "I feel unsafe" to an earlier "the driver
   * never came" can see what dispatch already has and cannot re-send it.
   */
  alreadySent?: string[];
  onDismiss: () => void;
}

// Deliberately NOT the driver_reports reason list. Those nine codes all accuse
// the driver of misconduct (unsafe driving, harassment, smoking), which is a
// different thing from "the app says I'm on a trip I'm not on". `not_in_car`
// is the case this whole feature exists for and is first, because a passenger
// watching a phantom trip tick along needs to find it without reading.
const REASONS: { code: string; label: string; hint?: string }[] = [
  {
    code: "not_in_car",
    label: "I'm not in the car",
    hint: "The trip started but you were never picked up",
  },
  {
    code: "driver_never_came",
    label: "The driver never arrived",
  },
  {
    code: "wrong_destination",
    label: "We're going the wrong way",
  },
  {
    code: "felt_unsafe",
    label: "I feel unsafe",
  },
  {
    code: "other",
    label: "Something else",
  },
];

export default function RideProblemModal({
  visible,
  rideId,
  status,
  alreadySent = [],
  onDismiss,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Multi-select: a situation usually has more than one thing wrong with it,
  // and making the passenger submit twice to say so is the same mistake as
  // driver_reports' one-per-ride lock.
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchPhone, setDispatchPhone] = useState<string | null>(null);

  // Fetched up front, not on success: calling is an alternative to flagging,
  // not a reward for it. A passenger who would rather just phone dispatch
  // should never have to file something first.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("get_ride_dispatch_phone", {
        p_ride_id: rideId,
      });
      if (!cancelled) setDispatchPhone(typeof data === "string" ? data : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, rideId]);

  const sentSet = useMemo(() => new Set(alreadySent), [alreadySent]);
  const requiresNote = selected.includes("other");
  // A note alone is a valid follow-up: it lets someone add detail to a reason
  // they have already sent, which is otherwise locked.
  const canSubmit =
    (selected.length > 0 || note.trim().length > 0) &&
    (!requiresNote || note.trim().length > 0);

  function toggle(code: string) {
    if (sentSet.has(code)) return; // already with dispatch
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    // A note-only follow-up still needs a reason for the RPC, so carry the
    // existing ones — dedupe on the server makes that a no-op.
    const reasons = selected.length > 0 ? selected : alreadySent;

    const { data, error: rpcError } = await supabase.rpc("flag_ride", {
      p_ride_id: rideId,
      p_reasons: reasons,
      p_note: note.trim() || null,
    });

    setSubmitting(false);
    if (rpcError) {
      // Don't collapse every failure into "call dispatch". If the ride ended
      // while this sheet was open, the flag correctly failed and telling the
      // passenger to phone dispatch about a finished trip is worse than saying
      // nothing. flag_ride raises a distinct message for that case.
      const msg = rpcError.message ?? "";
      if (msg.includes("not in progress")) {
        setError(
          "This ride has already ended. If you still need help, call dispatch.",
        );
      } else if (msg.includes("Not your ride")) {
        setError("We couldn't match this to your account. Please call dispatch.");
      } else {
        setError("We couldn't send this. Please call dispatch instead.");
      }
      return;
    }
    // The RPC hands back the phone too, so the success state can offer the call
    // even if the lookup above failed.
    const phone = (data as any)?.dispatch_phone;
    if (typeof phone === "string" && phone) setDispatchPhone(phone);
    setSubmitted(true);
  }

  function callDispatch() {
    if (!dispatchPhone) return;
    Linking.openURL(`tel:${dispatchPhone}`).catch(() => {});
  }

  function reset() {
    setSelected([]);
    setNote("");
    setSubmitted(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onDismiss();
  }

  const inRide = status === "in_progress";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.sheet}>
          {submitted ? (
            <View style={styles.successWrap}>
              <View style={styles.successIcon}>
                <Ionicons name="checkmark" size={32} color={colors.accentGreen} />
              </View>
              <Text style={styles.successTitle}>
                {alreadySent.length > 0 ? "Added to your report" : "Dispatch has been told"}
              </Text>
              <Text style={styles.successSubtitle}>
                They can see this ride and can cancel or correct it from their
                end. If it's urgent, call them.
              </Text>
              {dispatchPhone ? (
                <TouchableOpacity style={styles.callBtnWide} onPress={callDispatch}>
                  <Ionicons name="call" size={17} color="#fff" />
                  <Text style={styles.callTextWide}>Call dispatch</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.doneBtn} onPress={handleClose}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.header}>
                <View style={styles.handleBar} />
                <Text style={styles.title}>
                  {alreadySent.length > 0 ? "Add to your report" : "Something's wrong"}
                </Text>
                <Text style={styles.subtitle}>
                  {alreadySent.length > 0
                    ? "Dispatch already has what's ticked below. Add anything new."
                    : inRide
                      ? "This trip is marked as under way. Tell dispatch what's actually happening."
                      : "Tell dispatch what's happening and they'll sort it out."}
                </Text>
              </View>

              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {REASONS.map((r) => {
                  const sent = sentSet.has(r.code);
                  const isOn = sent || selected.includes(r.code);
                  return (
                    <TouchableOpacity
                      key={r.code}
                      style={[
                        styles.reasonRow,
                        isOn && styles.reasonRowSelected,
                        sent && styles.reasonRowSent,
                      ]}
                      onPress={() => toggle(r.code)}
                      activeOpacity={sent ? 1 : 0.7}
                      disabled={sent}
                    >
                      <Ionicons
                        name={isOn ? "checkbox" : "square-outline"}
                        size={20}
                        color={
                          sent
                            ? colors.accentGreen
                            : isOn
                              ? colors.accentOrange
                              : colors.textFaint
                        }
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.reasonText,
                            isOn && styles.reasonTextSelected,
                            sent && styles.reasonTextSent,
                          ]}
                        >
                          {r.label}
                        </Text>
                        {sent ? (
                          <Text style={styles.reasonSent}>
                            Already sent to dispatch
                          </Text>
                        ) : r.hint ? (
                          <Text style={styles.reasonHint}>{r.hint}</Text>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}

                <TextInput
                  style={styles.noteInput}
                  placeholder={
                    requiresNote
                      ? "Tell us what's happening (required)"
                      : "Anything else dispatch should know (optional)"
                  }
                  placeholderTextColor={colors.textMuted}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  numberOfLines={3}
                  maxLength={500}
                />

                {error ? <Text style={styles.errorText}>{error}</Text> : null}

                {dispatchPhone ? (
                  <TouchableOpacity style={styles.callRow} onPress={callDispatch}>
                    <Ionicons name="call-outline" size={17} color={colors.accentGreen} />
                    <Text style={styles.callRowText}>
                      Or call dispatch now
                    </Text>
                    <Ionicons
                      name="chevron-forward"
                      size={14}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                ) : null}
              </ScrollView>

              <View style={styles.actions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
                  <Text style={styles.cancelText}>Close</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    (!canSubmit || submitting) && styles.submitBtnDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={!canSubmit || submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.submitText}>
                    {alreadySent.length > 0 ? "Send update" : "Tell dispatch"}
                  </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.modalOverlay,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingBottom: Platform.OS === "ios" ? 40 : 28,
      borderTopWidth: 0.5,
      borderColor: colors.border,
      maxHeight: "85%",
    },
    header: {
      alignItems: "center",
      paddingTop: 12,
      paddingBottom: 8,
      paddingHorizontal: 24,
    },
    handleBar: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.textFaint,
      marginBottom: 20,
    },
    title: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 6,
    },
    subtitle: { fontSize: 14, color: colors.textSecondary, textAlign: "center" },
    scroll: { paddingHorizontal: 20 },
    scrollContent: { paddingTop: 16, paddingBottom: 8 },
    reasonRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
      marginBottom: 8,
    },
    reasonRowSelected: {
      borderColor: colors.accentOrange,
      backgroundColor: "rgba(232,80,10,0.08)",
    },
    reasonText: { fontSize: 14, color: colors.textTertiary },
    reasonTextSelected: { color: colors.textPrimary, fontWeight: "600" },
    reasonHint: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    reasonRowSent: {
      borderColor: "rgba(29,158,117,0.30)",
      backgroundColor: "rgba(29,158,117,0.07)",
      opacity: 0.85,
    },
    reasonTextSent: { color: colors.textSecondary, fontWeight: "600" },
    reasonSent: { fontSize: 12, color: colors.accentGreen, marginTop: 2 },
    noteInput: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      color: colors.textPrimary,
      fontSize: 14,
      padding: 14,
      minHeight: 74,
      textAlignVertical: "top",
      marginTop: 4,
      marginBottom: 4,
    },
    errorText: { color: colors.accentRed, fontSize: 13, marginTop: 8 },
    callRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 13,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
      marginTop: 8,
    },
    callRowText: {
      flex: 1,
      fontSize: 14,
      fontWeight: "600",
      color: colors.accentGreen,
    },
    actions: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    cancelBtn: {
      flex: 1,
      paddingVertical: 15,
      borderRadius: 14,
      alignItems: "center",
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    cancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
    submitBtn: {
      flex: 1.4,
      paddingVertical: 15,
      borderRadius: 14,
      alignItems: "center",
      backgroundColor: colors.accentOrange,
    },
    submitBtnDisabled: { opacity: 0.4 },
    submitText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    successWrap: { alignItems: "center", paddingTop: 36, paddingHorizontal: 28 },
    successIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: "rgba(29,158,117,0.12)",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 18,
    },
    successTitle: {
      fontSize: 19,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 8,
    },
    successSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 20,
    },
    callBtnWide: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      alignSelf: "stretch",
      paddingVertical: 15,
      borderRadius: 14,
      backgroundColor: colors.accentGreen,
      marginTop: 22,
    },
    callTextWide: { color: "#fff", fontSize: 15, fontWeight: "700" },
    doneBtn: { paddingVertical: 16, marginTop: 4 },
    doneText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
  });
