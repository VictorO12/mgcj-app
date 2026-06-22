import React, { useState, useMemo } from "react";
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
import { RootStackParamList } from "../../types";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, "PhoneEntry">;
};

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function formatDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export default function PhoneEntryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSendOTP() {
    const e164 = toE164(phone);
    if (e164.replace(/\D/g, "").length < 11) {
      Alert.alert(
        "Invalid number",
        "Please enter a valid 10-digit phone number.",
      );
      return;
    }
    setLoading(true);

    // Check if this number has a profile before sending OTP.
    // phone_is_registered() is a security-definer function so it works
    // without a session — RLS doesn't block it.
    const { data: isRegistered, error: checkError } = await supabase.rpc(
      "phone_is_registered",
      { p_phone: e164 },
    );

    if (checkError) {
      console.error("[PhoneEntry] phone check error:", checkError);
      // Fall through and let OTPVerifyScreen handle it if the check fails
    } else if (!isRegistered) {
      setLoading(false);
      Alert.alert(
        "No account found",
        "This number isn't registered. Would you like to sign up?",
        [
          { text: "Sign up", onPress: () => navigation.navigate("SignUp") },
          { text: "Cancel", style: "cancel" },
        ],
      );
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({ phone: e164 });
    setLoading(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    navigation.navigate("OTPVerify", { phone: e164, isNewUser: false });
  }

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

        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>
          Enter your phone number to log in to your account.
        </Text>

        <View style={styles.form}>
          <Text style={styles.label}>Phone number</Text>
          <View style={styles.inputRow}>
            <View style={styles.countryCode}>
              <Text style={styles.countryCodeText}>🇨🇦 +1</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="(902) 555-1234"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              value={formatDisplay(phone)}
              onChangeText={(t) => setPhone(t.replace(/\D/g, ""))}
              maxLength={14}
              autoFocus
            />
          </View>

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.6 }]}
            onPress={handleSendOTP}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>Send code</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.signupRow}>
          <Text style={styles.signupText}>Don't have an account? </Text>
          <TouchableOpacity onPress={() => navigation.navigate("SignUp")}>
            <Text style={styles.signupLink}>Sign up</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: {
    flex: 1,
    paddingHorizontal: 24,
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
  form: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
    gap: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.textTertiary,
    letterSpacing: 0.04,
  },
  inputRow: {
    flexDirection: "row",
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: colors.borderStrong,
    overflow: "hidden",
  },
  countryCode: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRightWidth: 0.5,
    borderRightColor: colors.borderStrong,
  },
  countryCodeText: { fontSize: 15, color: colors.textOnSurfaceLight },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: colors.textPrimary,
  },
  btn: {
    backgroundColor: colors.accentOrange,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  signupRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 28,
  },
  signupText: { fontSize: 14, color: colors.textSecondary },
  signupLink: { fontSize: 14, color: colors.accentOrange, fontWeight: "600" },
});
