import React, { useState } from "react";
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
              placeholderTextColor="#4B5563"
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  inner: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "ios" ? 60 : 40,
  },
  backBtn: { marginBottom: 28 },
  backText: { color: "#6B7280", fontSize: 15 },
  title: { fontSize: 28, fontWeight: "700", color: "#F1F5F9", marginBottom: 8 },
  subtitle: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 20,
    marginBottom: 32,
  },
  form: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
    color: "#9CA3AF",
    letterSpacing: 0.04,
  },
  inputRow: {
    flexDirection: "row",
    backgroundColor: "#111827",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    overflow: "hidden",
  },
  countryCode: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRightWidth: 0.5,
    borderRightColor: "rgba(255,255,255,0.1)",
  },
  countryCodeText: { fontSize: 15, color: "#CBD5E1" },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: "#F1F5F9",
  },
  btn: {
    backgroundColor: "#E8500A",
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
  signupText: { fontSize: 14, color: "#6B7280" },
  signupLink: { fontSize: 14, color: "#E8500A", fontWeight: "600" },
});
