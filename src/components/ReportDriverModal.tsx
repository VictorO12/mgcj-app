import React, { useState, useMemo } from "react";
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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

interface Props {
  visible: boolean;
  rideId: string;
  driverId: string;
  driverName: string | null;
  /** Called after submit (submitted=true) or cancel (submitted=false) */
  onDismiss: (submitted: boolean) => void;
}

const REASONS: { code: string; label: string }[] = [
  { code: "unsafe_driving", label: "Unsafe driving" },
  { code: "rude_behavior", label: "Rude or unprofessional behavior" },
  { code: "wrong_vehicle", label: "Different vehicle than expected" },
  { code: "wrong_driver", label: "Different driver than expected" },
  { code: "vehicle_condition", label: "Vehicle condition/cleanliness" },
  { code: "cash_request", label: "Asked for cash to bypass the app" },
  { code: "harassment", label: "Felt unsafe / harassed" },
  { code: "smoking", label: "Smoking in vehicle" },
  { code: "other", label: "Other" },
];

export default function ReportDriverModal({
  visible,
  rideId,
  driverId,
  driverName,
  onDismiss,
}: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstName = driverName?.split(" ")[0] ?? "this driver";
  const requiresComment = selectedReason === "other";
  const canSubmit =
    !!selectedReason && (!requiresComment || comment.trim().length > 0);

  async function handleSubmit() {
    if (!profile || !selectedReason || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    const { error: insertError } = await supabase
      .from("driver_reports")
      .insert({
        ride_id: rideId,
        passenger_id: profile.id,
        driver_id: driverId,
        reason: selectedReason,
        comment: comment.trim() || null,
      });

    setSubmitting(false);
    if (insertError) {
      if (insertError.code === "23505") {
        setError("You've already submitted a report for this ride.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      return;
    }

    setSubmitted(true);
    setTimeout(() => {
      reset();
      onDismiss(true);
    }, 1200);
  }

  function reset() {
    setSelectedReason(null);
    setComment("");
    setSubmitted(false);
    setError(null);
  }

  function handleCancel() {
    reset();
    onDismiss(false);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleCancel}
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
              <Text style={styles.successTitle}>Report submitted</Text>
              <Text style={styles.successSubtitle}>
                Thanks for letting us know. Our team will look into this.
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.header}>
                <View style={styles.handleBar} />
                <Text style={styles.title}>Report {firstName}</Text>
                <Text style={styles.subtitle}>
                  What happened? Select a reason below.
                </Text>
              </View>

              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {REASONS.map((r) => {
                  const selected = selectedReason === r.code;
                  return (
                    <TouchableOpacity
                      key={r.code}
                      style={[
                        styles.reasonRow,
                        selected && styles.reasonRowSelected,
                      ]}
                      onPress={() => setSelectedReason(r.code)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={20}
                        color={selected ? colors.accentOrange : colors.textFaint}
                      />
                      <Text
                        style={[
                          styles.reasonText,
                          selected && styles.reasonTextSelected,
                        ]}
                      >
                        {r.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                <TextInput
                  style={styles.commentInput}
                  placeholder={
                    requiresComment
                      ? "Please describe what happened (required)"
                      : "Add any details that might help us look into this (optional)"
                  }
                  placeholderTextColor={colors.textMuted}
                  value={comment}
                  onChangeText={setComment}
                  multiline
                  numberOfLines={4}
                  maxLength={500}
                />

                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </ScrollView>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={handleCancel}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
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
                    <Text style={styles.submitText}>Submit report</Text>
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

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  title: { fontSize: 20, fontWeight: "700", color: colors.textPrimary, marginBottom: 6 },
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
  reasonText: { fontSize: 14, color: colors.textTertiary, flex: 1 },
  reasonTextSelected: { color: colors.textPrimary, fontWeight: "600" },
  commentInput: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: 14,
    padding: 14,
    minHeight: 90,
    textAlignVertical: "top",
    marginTop: 4,
    marginBottom: 4,
  },
  errorText: { color: colors.accentRed, fontSize: 13, marginTop: 8 },
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
    flex: 2,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: colors.accentOrange,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  successWrap: {
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 24,
    gap: 12,
  },
  successIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(29,158,117,0.15)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(29,158,117,0.4)",
  },
  successTitle: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  successSubtitle: { fontSize: 13, color: colors.textSecondary, textAlign: "center" },
});
