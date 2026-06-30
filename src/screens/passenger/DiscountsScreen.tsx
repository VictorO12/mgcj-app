import React, { useState, useMemo, useEffect, useRef } from "react";
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
import AsyncStorage from "@react-native-async-storage/async-storage";
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
const STORAGE_KEY = "student_verification_pending";
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export default function DiscountsScreen({ onClose }: Props) {
  const { profile, refetch } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const realtimeRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const [studentEmail, setStudentEmail] = useState("");
  const [sendingVerification, setSendingVerification] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [minutesLeft, setMinutesLeft] = useState(30);

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

  // Load persisted pending state
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const { email, sentAt } = JSON.parse(raw);
        const elapsed = Date.now() - sentAt;
        if (elapsed < EXPIRY_MS) {
          setPendingEmail(email);
          setMinutesLeft(Math.ceil((EXPIRY_MS - elapsed) / 60000));
        } else {
          AsyncStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        AsyncStorage.removeItem(STORAGE_KEY);
      }
    });
  }, []);

  // Countdown timer while pending
  useEffect(() => {
    if (!pendingEmail) return;
    const interval = setInterval(() => {
      setMinutesLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setPendingEmail(null);
          AsyncStorage.removeItem(STORAGE_KEY);
          return 0;
        }
        return prev - 1;
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [pendingEmail]);

  // Realtime subscription — call refetch() when student_verified flips
  useEffect(() => {
    if (!profile?.id || studentDiscountValid) return;

    const channel = supabase
      .channel(`student-verify-${profile.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${profile.id}`,
        },
        (payload) => {
          if (payload.new?.student_verified) {
            refetch();
            AsyncStorage.removeItem(STORAGE_KEY);
            setPendingEmail(null);
          }
        },
      )
      .subscribe();

    realtimeRef.current = channel;
    return () => {
      channel.unsubscribe();
      realtimeRef.current = null;
    };
  }, [profile?.id, studentDiscountValid]);

  async function sendStudentVerification() {
    const trimmedEmail = studentEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      Alert.alert("Invalid email", "Please enter a valid email address.");
      return;
    }

    setSendingVerification(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
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

      const record = { email: trimmedEmail, sentAt: Date.now() };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      setPendingEmail(trimmedEmail);
      setMinutesLeft(30);
    } catch (err) {
      console.error("Student verification error:", err);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setSendingVerification(false);
    }
  }

  function clearPending() {
    setPendingEmail(null);
    setStudentEmail("");
    AsyncStorage.removeItem(STORAGE_KEY);
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
            <VerifiedState profile={profile} colors={colors} styles={styles} />
          ) : pendingEmail ? (
            <PendingState
              email={pendingEmail}
              minutesLeft={minutesLeft}
              onBack={clearPending}
              colors={colors}
              styles={styles}
            />
          ) : (
            <InputState
              studentEmail={studentEmail}
              setStudentEmail={setStudentEmail}
              sendingVerification={sendingVerification}
              onSend={sendStudentVerification}
              colors={colors}
              styles={styles}
            />
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function VerifiedState({ profile, colors, styles }: { profile: any; colors: Colors; styles: any }) {
  const now = new Date();
  const nextSept = new Date(now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear(), 8, 1);
  const validUntil = nextSept.toLocaleDateString("en-CA", { month: "long", year: "numeric" });

  return (
    <View style={styles.stateContainer}>
      <View style={[styles.iconCircle, { backgroundColor: "rgba(29,158,117,0.15)" }]}>
        <Ionicons name="checkmark-circle" size={48} color="#1D9E75" />
      </View>
      <Text style={styles.stateHeading}>Student Verified</Text>
      <Text style={styles.stateEmail}>{profile?.student_email}</Text>
      <View style={[styles.badge, { borderColor: "rgba(29,158,117,0.3)", backgroundColor: "rgba(29,158,117,0.1)" }]}>
        <Ionicons name="school-outline" size={13} color="#1D9E75" style={{ marginRight: 5 }} />
        <Text style={[styles.badgeText, { color: "#1D9E75" }]}>
          Valid until {validUntil}
        </Text>
      </View>
      <Text style={styles.stateNote}>Re-verification required each September.</Text>
    </View>
  );
}

function PendingState({
  email, minutesLeft, onBack, colors, styles,
}: { email: string; minutesLeft: number; onBack: () => void; colors: Colors; styles: any }) {
  return (
    <View style={styles.stateContainer}>
      <View style={[styles.iconCircle, { backgroundColor: "rgba(74,158,255,0.12)" }]}>
        <Ionicons name="mail-outline" size={44} color={colors.accentBlue} />
      </View>
      <Text style={styles.stateHeading}>Check your inbox</Text>
      <Text style={styles.stateEmail}>{email}</Text>
      <Text style={styles.stateNote}>
        We sent a confirmation link to that address. Tap it to activate your student discount.
      </Text>
      <View style={[styles.badge, { borderColor: "rgba(74,158,255,0.25)", backgroundColor: "rgba(74,158,255,0.08)" }]}>
        <Ionicons name="time-outline" size={13} color={colors.accentBlue} style={{ marginRight: 5 }} />
        <Text style={[styles.badgeText, { color: colors.accentBlue }]}>
          Link expires in {minutesLeft} min
        </Text>
      </View>
      <TouchableOpacity style={styles.backTextBtn} onPress={onBack}>
        <Ionicons name="arrow-back" size={14} color={colors.textSecondary} style={{ marginRight: 4 }} />
        <Text style={styles.backTextLabel}>Try a different email</Text>
      </TouchableOpacity>
    </View>
  );
}

function InputState({
  studentEmail, setStudentEmail, sendingVerification, onSend, colors, styles,
}: {
  studentEmail: string;
  setStudentEmail: (v: string) => void;
  sendingVerification: boolean;
  onSend: () => void;
  colors: Colors;
  styles: any;
}) {
  return (
    <>
      <Text style={styles.fieldNote}>
        Confirm your school email to unlock the student discount, where offered by your taxi company.
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
        onPress={onSend}
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
    // Shared state layout
    stateContainer: {
      alignItems: "center",
      paddingVertical: 8,
      gap: 10,
    },
    iconCircle: {
      width: 80,
      height: 80,
      borderRadius: 40,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    stateHeading: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.textPrimary,
      textAlign: "center",
    },
    stateEmail: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: "center",
    },
    stateNote: {
      fontSize: 12,
      color: colors.textMuted,
      textAlign: "center",
      lineHeight: 18,
      paddingHorizontal: 8,
    },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
      marginTop: 2,
    },
    badgeText: {
      fontSize: 12,
      fontWeight: "600",
    },
    backTextBtn: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 6,
      paddingVertical: 4,
    },
    backTextLabel: {
      fontSize: 13,
      color: colors.textSecondary,
    },
    // Input state
    field: { gap: 4, width: "100%" },
    fieldLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: "500" },
    input: { fontSize: 15, color: colors.textPrimary, paddingVertical: 8 },
    fieldNote: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: 8 },
    saveBtn: {
      backgroundColor: colors.accentOrange,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: "center",
      marginTop: 14,
      width: "100%",
    },
    saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  });
