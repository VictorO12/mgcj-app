import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface Props {
  onClose: () => void;
}

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl;
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey;

export default function DiscountsScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [studentEmail, setStudentEmail] = useState("");
  const [sendingVerification, setSendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  const studentDiscountValid = useMemo(() => {
    if (!profile?.student_verified || !profile.student_verified_at) return false;
    const verifiedAt = new Date(profile.student_verified_at);
    const now = new Date();
    const septFirstThisCycle = new Date(
      now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1,
      8,
      1,
    );
    return verifiedAt >= septFirstThisCycle;
  }, [profile?.student_verified, profile?.student_verified_at]);

  async function sendStudentVerification() {
    const trimmedEmail = studentEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      Alert.alert("Invalid email", "Please enter a valid email address.");
      return;
    }

    setSendingVerification(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("No session");

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/request-student-verification`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ email: trimmedEmail }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        Alert.alert("Could not send", data.error ?? "Please try again.");
        return;
      }
      setVerificationSent(true);
      Alert.alert(
        "Check your email",
        "We've sent a confirmation link to your school email. Tap it to activate your student discount.",
      );
    } catch (err) {
      console.error("Student verification error:", err);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setSendingVerification(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Discounts</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>STUDENT DISCOUNT</Text>
          {studentDiscountValid ? (
            <View style={styles.field}>
              <Text style={styles.fieldValue}>
                Verified — {profile?.student_email}
              </Text>
              <Text style={styles.fieldNote}>
                Re-verification required each September.
              </Text>
            </View>
          ) : verificationSent ? (
            <Text style={styles.fieldNote}>
              Confirmation email sent — check your inbox and tap the link to
              finish verifying.
            </Text>
          ) : (
            <>
              <Text style={styles.fieldNote}>
                Confirm your school email to unlock the student discount,
                where offered by your taxi company.
              </Text>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>School email</Text>
                <TextInput
                  style={styles.input}
                  value={studentEmail}
                  onChangeText={setStudentEmail}
                  placeholder="you@school.ca"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                />
              </View>
              <TouchableOpacity
                style={[styles.saveBtn, sendingVerification && { opacity: 0.7 }]}
                onPress={sendStudentVerification}
                disabled={sendingVerification}
                activeOpacity={0.85}
              >
                {sendingVerification ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>Send confirmation email</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
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
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 48 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
      padding: 20,
      marginBottom: 16,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textMuted,
      letterSpacing: 0.08,
      marginBottom: 14,
    },
    field: { gap: 4 },
    fieldLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: "500" },
    input: { fontSize: 15, color: colors.textPrimary, paddingVertical: 8 },
    fieldValue: { fontSize: 15, color: colors.textOnSurfaceLight, paddingVertical: 8 },
    fieldNote: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    saveBtn: {
      backgroundColor: colors.accentOrange,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: "center",
      marginTop: 14,
    },
    saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  });
