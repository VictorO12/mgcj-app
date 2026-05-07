import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RouteProp } from "@react-navigation/native";
import { RootStackParamList } from "../../types";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, "OTPVerify">;
  route: RouteProp<RootStackParamList, "OTPVerify">;
};

const CODE_LENGTH = 6;

export default function OTPVerifyScreen({ navigation, route }: Props) {
  const { phone, name, isNewUser, isDriver, inviteCode } = route.params;
  const { refetch } = useAuth();
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [loading, setLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(30);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    if (resendTimer <= 0) return;
    const t = setTimeout(() => setResendTimer((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [resendTimer]);

  function handleDigit(value: string, index: number) {
    if (value.length === CODE_LENGTH) {
      const pasted = value.replace(/\D/g, "").slice(0, CODE_LENGTH).split("");
      setDigits(pasted);
      inputRefs.current[CODE_LENGTH - 1]?.focus();
      verifyCode(pasted.join(""));
      return;
    }
    const digit = value.replace(/\D/g, "").slice(-1);
    const updated = [...digits];
    updated[index] = digit;
    setDigits(updated);
    if (digit && index < CODE_LENGTH - 1) inputRefs.current[index + 1]?.focus();
    if (updated.every((d) => d !== "") && digit) verifyCode(updated.join(""));
  }

  function handleBackspace(index: number) {
    if (digits[index]) {
      const updated = [...digits];
      updated[index] = "";
      setDigits(updated);
    } else if (index > 0) {
      inputRefs.current[index - 1]?.focus();
      const updated = [...digits];
      updated[index - 1] = "";
      setDigits(updated);
    }
  }

  async function verifyCode(code: string) {
    setLoading(true);

    console.log("[OTP] verifying code for phone:", phone);
    console.log("[OTP] isDriver:", isDriver, "inviteCode:", inviteCode);

    // ── Verify OTP ──────────────────────────────────────────────
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token: code,
      type: "sms",
    });

    if (error) {
      setLoading(false);
      setDigits(Array(CODE_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
      Alert.alert("Incorrect code", "That code didn't match. Try again.");
      return;
    }

    console.log("[OTP] auth verified, user id:", data.user?.id);

    if (!data.user) {
      setLoading(false);
      Alert.alert("Error", "Something went wrong. Please try again.");
      return;
    }

    const userId = data.user.id;

    // ── Check if profile already exists ─────────────────────────
    const { data: existing, error: existingError } = await supabase
      .from("profiles")
      .select("id, name, role")
      .eq("id", userId)
      .single();

    console.log("[OTP] existing profile:", existing, "error:", existingError);
    console.log(
      "[OTP] isDriver check:",
      isDriver,
      "| inviteCode:",
      inviteCode,
      "| existing:",
      !!existing,
    );

    // ── DRIVER REGISTRATION PATH ─────────────────────────────────
    if (isDriver && inviteCode && !existing) {
      console.log("[OTP] entering driver registration path");

      // Validate invite code one final time
      const { data: invite, error: inviteError } = await supabase
        .from("driver_invites")
        .select("id, used")
        .eq("code", inviteCode)
        .single();

      console.log("[OTP] invite lookup:", invite, "error:", inviteError);

      if (!invite || invite.used) {
        await supabase.auth.signOut();
        setLoading(false);
        Alert.alert(
          "Invalid invite code",
          "This invite code is no longer valid. Please contact M&G C&J dispatch.",
          [{ text: "OK", onPress: () => navigation.navigate("Welcome") }],
        );
        return;
      }

      // Wait briefly for trigger, then check if profile was created
      // Upsert profile directly — no waiting for trigger
      console.log("[OTP] upserting driver profile");
      const { error: upsertError } = await supabase.from("profiles").upsert(
        {
          id: userId,
          phone,
          name: name ?? null,
          role: "driver",
        },
        { onConflict: "id" },
      );
      console.log("[OTP] profile upsert:", upsertError);

      // Create driver record
      const { error: driverError } = await supabase
        .from("drivers")
        .upsert({ id: userId, is_active: false }, { onConflict: "id" });
      console.log("[OTP] driver record upsert:", driverError);

      // Mark invite as used
      await supabase
        .from("driver_invites")
        .update({ used: true })
        .eq("id", invite.id);
      console.log("[OTP] invite marked used");

      // Immediately update useAuth with the new driver profile
      await refetch();
      setLoading(false);
      return;
    }

    // ── PASSENGER REGISTRATION PATH ──────────────────────────────
    console.log("[OTP] passenger path");

    if (!existing) {
      // New user — trigger creates the row, wait then update name
      await new Promise((r) => setTimeout(r, 800));
      if (name) {
        await supabase.from("profiles").update({ name }).eq("id", userId);
      }
    } else if (isNewUser && name && !existing.name) {
      // Existing auth user but no name yet
      await supabase.from("profiles").update({ name }).eq("id", userId);
    }

    setLoading(false);
    // useAuth onAuthStateChange handles routing for passengers
  }

  async function handleResend() {
    const { error } = await supabase.auth.signInWithOtp({ phone });
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setResendTimer(30);
    setDigits(Array(CODE_LENGTH).fill(""));
    inputRefs.current[0]?.focus();
    Alert.alert("Code sent", "A new code has been sent to your phone.");
  }

  const displayPhone = phone.replace(
    /(\+1)(\d{3})(\d{3})(\d{4})/,
    "$1 ($2) $3-$4",
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.inner}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Check your texts</Text>
        <Text style={styles.subtitle}>
          We sent a 6-digit code to{"\n"}
          <Text style={styles.phoneHighlight}>{displayPhone}</Text>
        </Text>

        {isDriver && (
          <View style={styles.driverBadge}>
            <Text style={styles.driverBadgeText}>🚗 Registering as driver</Text>
          </View>
        )}

        <View style={styles.codeRow}>
          {digits.map((digit, i) => (
            <TextInput
              key={i}
              ref={(ref) => {
                inputRefs.current[i] = ref;
              }}
              style={[styles.digitBox, digit ? styles.digitBoxFilled : null]}
              value={digit}
              onChangeText={(v) => handleDigit(v, i)}
              onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === "Backspace") handleBackspace(i);
              }}
              keyboardType="number-pad"
              maxLength={6}
              selectTextOnFocus
              autoFocus={i === 0}
            />
          ))}
        </View>

        {loading && (
          <View style={styles.verifyingRow}>
            <ActivityIndicator color="#E8500A" size="small" />
            <Text style={styles.verifyingText}>
              {isDriver ? "Setting up driver account…" : "Verifying…"}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.resendBtn}
          onPress={handleResend}
          disabled={resendTimer > 0}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.resendText,
              resendTimer > 0 && styles.resendDisabled,
            ]}
          >
            {resendTimer > 0 ? `Resend code in ${resendTimer}s` : "Resend code"}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  inner: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: Platform.OS === "ios" ? 60 : 40,
  },
  backBtn: { marginBottom: 36 },
  backText: { color: "#6B7280", fontSize: 15 },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 15,
    color: "#6B7280",
    lineHeight: 22,
    marginBottom: 24,
  },
  phoneHighlight: { color: "#E8500A", fontWeight: "600" },
  driverBadge: {
    backgroundColor: "rgba(29,158,117,0.1)",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.3)",
    alignSelf: "flex-start",
    marginBottom: 24,
  },
  driverBadgeText: { fontSize: 13, color: "#1D9E75", fontWeight: "500" },
  codeRow: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    marginBottom: 32,
  },
  digitBox: {
    width: 46,
    height: 58,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#1E2A3A",
    textAlign: "center",
    fontSize: 24,
    fontWeight: "600",
    color: "#F1F5F9",
  },
  digitBoxFilled: { borderColor: "#E8500A" },
  verifyingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 24,
  },
  verifyingText: { color: "#E8500A", fontSize: 14 },
  resendBtn: { alignItems: "center", marginTop: 8 },
  resendText: { fontSize: 14, color: "#E8500A", fontWeight: "500" },
  resendDisabled: { color: "#374151" },
});
