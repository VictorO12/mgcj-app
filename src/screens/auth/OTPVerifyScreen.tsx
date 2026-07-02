import React, { useState, useRef, useEffect, useMemo } from "react";
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
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, "OTPVerify">;
  route: RouteProp<RootStackParamList, "OTPVerify">;
};

const CODE_LENGTH = 6;

export default function OTPVerifyScreen({ navigation, route }: Props) {
  const { phone, name, isNewUser, isDriver, inviteCode } = route.params;
  const { refetch, holdLoading, releaseLoading } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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

    // Hold AuthContext navigation so the home screen doesn't flash while
    // we validate the invite code after OTP verification.
    if (isDriver && inviteCode) holdLoading();

    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token: code,
      type: "sms",
    });

    if (error) {
      if (isDriver && inviteCode) releaseLoading();
      setLoading(false);
      setDigits(Array(CODE_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
      Alert.alert("Incorrect code", "That code didn't match. Try again.");
      return;
    }

    if (!data.user) {
      setLoading(false);
      Alert.alert("Error", "Something went wrong. Please try again.");
      return;
    }

    const userId = data.user.id;
    console.log("[OTP] auth verified, user id:", userId);

    // Check for profile by auth user id (normal path)
    const { data: existing } = await supabase
      .from("profiles")
      .select("id, name, role")
      .eq("id", userId)
      .maybeSingle();

    console.log("[OTP] existing profile by id:", existing);

    // ── DRIVER PATH ──────────────────────────────────────────────
    if (isDriver && inviteCode) {
      console.log("[OTP] entering driver registration path");

      const { data: invite } = await supabase
        .from("driver_invites")
        .select("id, used, company_id")
        .eq("code", inviteCode)
        .single();

      if (!invite || invite.used) {
        // Clean up the auto-created profile and release the navigation hold
        // before signing out so the home screen never becomes visible.
        await supabase.from("profiles").delete().eq("id", userId);
        releaseLoading();
        await supabase.auth.signOut();
        setLoading(false);
        Alert.alert(
          "Invalid invite code",
          invite?.used
            ? "This invite code has already been used. Please contact dispatch."
            : "That invite code wasn't recognised. Please check it and try again.",
          [{ text: "OK", onPress: () => navigation.navigate("DriverSignUp") }],
        );
        return;
      }

      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert(
          { id: userId, phone, name: name ?? null, role: "driver", company_id: invite.company_id ?? null },
          { onConflict: "id" },
        );
      console.log("[OTP] driver profile upsert:", upsertError ?? "ok");

      const { error: driverError } = await supabase
        .from("drivers")
        .upsert({ id: userId, is_active: false }, { onConflict: "id" });
      console.log("[OTP] driver record upsert:", driverError ?? "ok");

      const { error: inviteError } = await supabase.rpc("mark_invite_used", { p_invite_id: invite.id });
      console.log("[OTP] invite mark used — error:", inviteError ?? "none");

      releaseLoading();
      await refetch();
      setLoading(false);
      return;
    }

    // ── PASSENGER PATH ───────────────────────────────────────────
    console.log("[OTP] passenger path");

    // Check if a guest profile exists for this phone number
    // (created by dispatch when booking a ride for an unregistered passenger)
    if (!existing) {
      const { data: guestProfile } = await supabase
        .from("profiles")
        .select("id, name, role")
        .eq("phone", phone)
        .eq("role", "passenger")
        .maybeSingle();

      console.log("[OTP] guest profile by phone:", guestProfile);

      if (guestProfile && guestProfile.id !== userId) {
        // Guest profile exists from a dispatch booking — merge it
        // Update the profile's id to the new real auth user's id
        console.log(
          "[OTP] merging guest profile:",
          guestProfile.id,
          "→",
          userId,
        );
        const { error: mergeError } = await supabase
          .from("profiles")
          .update({ id: userId, name: name ?? guestProfile.name })
          .eq("id", guestProfile.id);

        if (mergeError) {
          console.log("[OTP] merge error:", mergeError);
          // Merge failed (likely FK constraint) — fall through to normal upsert
        } else {
          // Also update rides that reference the old guest profile id
          await supabase
            .from("rides")
            .update({ passenger_id: userId })
            .eq("passenger_id", guestProfile.id);

          console.log("[OTP] guest merge complete");
          await refetch();
          setLoading(false);
          return;
        }
      }
    }

    // No guest profile found — handle normal sign-in / sign-up
    if (!existing && !isNewUser) {
      // Sign-in attempt but no profile exists — number not registered
      console.log("[OTP] sign-in blocked: no profile for this number");
      await supabase.auth.signOut();
      setLoading(false);
      Alert.alert(
        "No account found",
        "This number isn't registered. Would you like to sign up?",
        [
          { text: "Sign up", onPress: () => navigation.navigate("SignUp") },
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => navigation.navigate("Welcome"),
          },
        ],
      );
      return;
    }

    if (!existing && isNewUser) {
      // New signup — upsert the full profile
      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert(
          { id: userId, phone, name: name ?? null, role: "passenger" },
          { onConflict: "id" },
        );
      console.log("[OTP] passenger profile upsert:", upsertError);
    }

    await refetch();
    setLoading(false);
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
            <ActivityIndicator color={colors.accentOrange} size="small" />
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

const makeStyles = (colors: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: Platform.OS === "ios" ? 60 : 40,
  },
  backBtn: { marginBottom: 28 },
  backText: { color: colors.textSecondary, fontSize: 15 },
  title: { fontSize: 28, fontWeight: "700", color: colors.textPrimary, marginBottom: 8 },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: 32,
  },
  phoneHighlight: { color: colors.textPrimary, fontWeight: "600" },
  driverBadge: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(29,158,117,0.12)",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginBottom: 24,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.3)",
  },
  driverBadgeText: { fontSize: 13, color: colors.accentGreen, fontWeight: "500" },
  codeRow: { flexDirection: "row", gap: 10, marginBottom: 32 },
  digitBox: {
    flex: 1,
    height: 56,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 0.5,
    borderColor: colors.borderStrong,
    textAlign: "center",
    fontSize: 22,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  digitBoxFilled: {
    borderColor: colors.accentOrange,
    backgroundColor: "rgba(232,80,10,0.08)",
  },
  verifyingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 24,
  },
  verifyingText: { fontSize: 14, color: colors.textTertiary },
  resendBtn: { alignSelf: "center" },
  resendText: { fontSize: 14, color: colors.accentOrange, fontWeight: "500" },
  resendDisabled: { color: colors.textMuted },
});
