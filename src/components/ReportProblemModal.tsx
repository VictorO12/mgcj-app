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
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

interface Props {
  visible: boolean;
  /** Optional ride to attach the report to, if the report was opened from a ride context. */
  rideId?: string;
  onDismiss: () => void;
}

const CATEGORIES: { code: string; label: string }[] = [
  { code: "bug", label: "Bug / app not working" },
  { code: "payment", label: "Payment issue" },
  { code: "account", label: "Account issue" },
  { code: "other", label: "Other" },
];

export default function ReportProblemModal({ visible, rideId, onDismiss }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!selectedCategory && message.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const { error: insertError } = await supabase.from("technical_reports").insert({
      category: selectedCategory,
      message: message.trim(),
      ride_id: rideId ?? null,
    });

    setSubmitting(false);
    if (insertError) {
      setError("Something went wrong. Please try again.");
      return;
    }

    setSubmitted(true);
    setTimeout(() => {
      reset();
      onDismiss();
    }, 1200);
  }

  function reset() {
    setSelectedCategory(null);
    setMessage("");
    setSubmitted(false);
    setError(null);
  }

  function handleCancel() {
    reset();
    onDismiss();
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
                <Text style={styles.title}>Report a problem</Text>
                <Text style={styles.subtitle}>
                  Tell us what's going wrong and we'll look into it.
                </Text>
              </View>

              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {CATEGORIES.map((c) => {
                  const selected = selectedCategory === c.code;
                  return (
                    <TouchableOpacity
                      key={c.code}
                      style={[styles.reasonRow, selected && styles.reasonRowSelected]}
                      onPress={() => setSelectedCategory(c.code)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={20}
                        color={selected ? colors.accentOrange : colors.textFaint}
                      />
                      <Text
                        style={[styles.reasonText, selected && styles.reasonTextSelected]}
                      >
                        {c.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                <TextInput
                  style={styles.commentInput}
                  placeholder="Describe what happened"
                  placeholderTextColor={colors.textMuted}
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  numberOfLines={4}
                  maxLength={1000}
                />

                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </ScrollView>

              <View style={styles.actions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
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
