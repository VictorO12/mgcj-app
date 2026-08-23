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

      // Validate AND consume in one call. This used to be a direct table read
      // (which needed a driver_invites SELECT policy so open that any anonymous
      // session could enumerate every unused code on the platform) followed by
      // mark_invite_used() — a check-then-act two devices could both win.
      // consume_invite_code does both atomically; see 20260744.
      const { data: consumed, error: consumeError } = await supabase.rpc(
        "consume_invite_code",
        { p_code: inviteCode, p_phone: phone },
      );
      const invite = consumed as
        | { valid: boolean; reason?: string; company_id?: string | null }
        | null;

      if (consumeError || !invite?.valid) {
        // Clean up the auto-created profile and release the navigation hold
        // before signing out so the home screen never becomes visible.
        await supabase.from("profiles").delete().eq("id", userId);
        releaseLoading();
        await supabase.auth.signOut({ scope: "local" });
        setLoading(false);
        Alert.alert(
          "Invalid invite code",
          invite?.reason === "already_used"
            ? "This invite code has already been used. Please contact dispatch."
            : invite?.reason === "phone_mismatch"
              ? "This invite code was issued to a different phone number."
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

      releaseLoading();
      await refetch();
      setLoading(false);
      return;
    }

    // ── PASSENGER PATH ───────────────────────────────────────────
    console.log("[OTP] passenger path");

    // Handle normal sign-in / sign-up. A dispatch-created guest profile on
    // this number is NOT merged here: guest ride history stays with the guest
    // row, and only live rides are re-pointed (see claim_guest_rides).
    if (!existing && !isNewUser) {
      // Sign-in attempt but no profile exists — number not registered
      console.log("[OTP] sign-in blocked: no profile for this number");
      await supabase.auth.signOut({ scope: "local" });
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

    // A dispatch-created guest profile may be holding this number. Hand over
    // any ride that is still *happening* — the passenger may be waiting on it
    // right now — and retire the guest row. Completed history is deliberately
    // left behind.
    //
    // MUST run BEFORE the upsert below. profiles.phone carries a global unique
    // constraint (profiles_phone_key), so the guest row has to release the
    // number before the real profile can take it. Running it after produced a
    // 23505 on signup for anyone dispatch had booked before.
    //
    // Safe this early because on_auth_user_created has already created this
    // user's profiles row (phone NULL), which is all rides.passenger_id needs.
    // Idempotent, returns 0 when there is no guest row.
    const { data: claimedRides, error: claimError } =
      await supabase.rpc("claim_guest_rides");
    if (claimError) {
      console.log("[OTP] guest ride claim failed:", claimError);
    } else if (claimedRides) {
      console.log("[OTP] claimed live guest rides:", claimedRides);
    }

    if (isNewUser) {
      // Unconditional, matching the driver path above. This was gated on
      // `!existing`, which has been dead code since the on_auth_user_created
      // trigger began inserting a bare profiles row at auth-user creation:
      // `existing` is already non-null here on a brand-new signup (verified in
      // a live log, name: null, role: passenger). Two consequences, both
      // long-standing and both fixed by removing the gate — the name typed at
      // sign-up was never written, and the row kept the phone the trigger
      // copied from auth.users, which Supabase stores WITHOUT the leading '+'
      // and so never matched an E.164 lookup from dispatch.
      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert(
          {
            id: userId,
            // Route param is E.164 (with '+'); auth.users.phone is not.
            phone,
            // Never clobber a name already on the row with null.
            name: name?.trim() || existing?.name || null,
            role: "passenger",
          },
          { onConflict: "id" },
        );
      console.log("[OTP] passenger profile upsert:", upsertError ?? "ok");
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
