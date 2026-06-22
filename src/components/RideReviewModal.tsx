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
  /** Called after submit (submitted=true, rating=number) or skip (submitted=false) */
  onDismiss: (submitted: boolean, rating?: number) => void;
}

export default function RideReviewModal({
  visible,
  rideId,
  driverId,
  driverName,
  onDismiss,
}: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const displayRating = hoveredStar || rating;
  const firstName = driverName?.split(" ")[0] ?? "your driver";

  async function handleSubmit() {
    if (!profile || rating === 0) return;
    setSubmitting(true);
    const { error } = await supabase.from("ride_reviews").insert({
      ride_id: rideId,
      passenger_id: profile.id,
      driver_id: driverId,
      rating,
      comment: comment.trim() || null,
    });
    setSubmitting(false);
    if (!error) {
      setSubmitted(true);
      const submittedRating = rating;
      setTimeout(() => {
        resetAndDismiss(true, submittedRating);
      }, 1000);
    }
  }

  function resetAndDismiss(wasSubmitted: boolean, submittedRating?: number) {
    setRating(0);
    setHoveredStar(0);
    setComment("");
    setSubmitted(false);
    onDismiss(wasSubmitted, submittedRating);
  }

  const STAR_LABELS = ["", "Poor", "Fair", "Good", "Great", "Excellent"];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => resetAndDismiss(false)}
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
              <Text style={styles.successTitle}>Thanks for the feedback!</Text>
            </View>
          ) : (
            <>
              <View style={styles.header}>
                <View style={styles.handleBar} />
                <Text style={styles.title}>Rate your ride</Text>
                <Text style={styles.subtitle}>
                  How was your experience with {firstName}?
                </Text>
              </View>

              <View style={styles.starsRow}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <TouchableOpacity
                    key={star}
                    onPress={() => setRating(star)}
                    onPressIn={() => setHoveredStar(star)}
                    onPressOut={() => setHoveredStar(0)}
                    activeOpacity={0.7}
                    style={styles.starBtn}
                  >
                    <Ionicons
                      name={displayRating >= star ? "star" : "star-outline"}
                      size={40}
                      color={displayRating >= star ? colors.accentAmber : colors.textFaint}
                    />
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.starLabel}>
                {displayRating > 0 ? STAR_LABELS[displayRating] : " "}
              </Text>

              <TextInput
                style={styles.commentInput}
                placeholder="Add a comment (optional)"
                placeholderTextColor={colors.textMuted}
                value={comment}
                onChangeText={setComment}
                multiline
                numberOfLines={3}
                maxLength={300}
              />

              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.skipBtn}
                  onPress={() => resetAndDismiss(false)}
                >
                  <Text style={styles.skipText}>Skip</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    (rating === 0 || submitting) && styles.submitBtnDisabled,
                  ]}
                  onPress={handleSubmit}
                  disabled={rating === 0 || submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.submitText}>Submit</Text>
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
  starsRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingVertical: 20,
    gap: 8,
  },
  starBtn: { padding: 4 },
  starLabel: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: "600",
    color: colors.accentAmber,
    height: 20,
    marginBottom: 16,
  },
  commentInput: {
    marginHorizontal: 20,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: 14,
    padding: 14,
    minHeight: 80,
    textAlignVertical: "top",
    marginBottom: 20,
  },
  actions: { flexDirection: "row", gap: 12, paddingHorizontal: 20 },
  skipBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  skipText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
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
    gap: 16,
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
});
