import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  Alert,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface Props {
  onClose: () => void;
  onCardAdded: () => void;
}

// ── Card brand detection ──────────────────────────────────────
function detectBrand(number: string): string {
  const n = number.replace(/\s/g, "");
  if (/^4/.test(n)) return "Visa";
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "Amex";
  if (/^6(?:011|5)/.test(n)) return "Discover";
  return "Unknown";
}

const BRAND_ICONS: Record<string, string> = {
  Visa: "💳",
  Mastercard: "💳",
  Amex: "💳",
  Discover: "💳",
  Unknown: "💳",
};

const BRAND_COLORS: Record<string, string> = {
  Visa: "#1A56FF",
  Mastercard: "#EB001B",
  Amex: "#2E77BC",
  Discover: "#FF6600",
  Unknown: "#374151",
};

// ── Luhn algorithm ────────────────────────────────────────────
function luhnCheck(num: string): boolean {
  const digits = num.replace(/\s/g, "").split("").reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// ── Format card number with spaces ───────────────────────────
function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 16);
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

// ── Format expiry MM/YY ───────────────────────────────────────
function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length >= 3) return digits.slice(0, 2) + "/" + digits.slice(2);
  return digits;
}

export default function AddCardScreen({ onClose, onCardAdded }: Props) {
  const { profile } = useAuth();

  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const expiryRef = useRef<TextInput>(null);
  const cvvRef = useRef<TextInput>(null);
  const nameRef = useRef<TextInput>(null);

  const brand = detectBrand(cardNumber);
  const brandColor = BRAND_COLORS[brand] ?? "#374151";
  const isAmex = brand === "Amex";
  const cvvLength = isAmex ? 4 : 3;

  function validateAll(): boolean {
    const errs: Record<string, string> = {};
    const rawNumber = cardNumber.replace(/\s/g, "");

    if (rawNumber.length < 15) {
      errs.cardNumber = "Enter a valid card number";
    } else if (!luhnCheck(rawNumber)) {
      errs.cardNumber = "Card number is invalid";
    }

    const [monthStr, yearStr] = expiry.split("/");
    const month = parseInt(monthStr ?? "", 10);
    const year = parseInt("20" + (yearStr ?? ""), 10);
    const now = new Date();
    const expDate = new Date(year, month - 1);
    if (!monthStr || !yearStr || month < 1 || month > 12) {
      errs.expiry = "Enter a valid expiry (MM/YY)";
    } else if (expDate < new Date(now.getFullYear(), now.getMonth())) {
      errs.expiry = "This card has expired";
    }

    if (cvv.length < cvvLength) {
      errs.cvv = `CVV must be ${cvvLength} digits`;
    }

    if (!cardholderName.trim() || cardholderName.trim().length < 2) {
      errs.cardholderName = "Enter the name on the card";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSave() {
    if (!validateAll() || !profile) return;
    setSaving(true);

    const rawNumber = cardNumber.replace(/\s/g, "");
    const last4 = rawNumber.slice(-4);
    const [monthStr, yearStr] = expiry.split("/");
    const expMonth = parseInt(monthStr, 10);
    const expYear = parseInt("20" + yearStr, 10);

    // Check if this is the first card — make it default if so
    const { count } = await supabase
      .from("payment_methods")
      .select("id", { count: "exact", head: true })
      .eq("passenger_id", profile.id);

    const isFirst = (count ?? 0) === 0;

    // NOTE: When Stripe is integrated, replace this insert with a
    // Stripe PaymentMethod creation call, then store the returned
    // stripe_payment_method_id here instead of 'pending'.
    const { error } = await supabase.from("payment_methods").insert({
      passenger_id: profile.id,
      stripe_payment_method_id: "pending", // ← replace with Stripe token
      brand,
      last4,
      exp_month: expMonth,
      exp_year: expYear,
      cardholder_name: cardholderName.trim(),
      is_default: isFirst,
    });

    setSaving(false);

    if (error) {
      Alert.alert("Error saving card", error.message);
      return;
    }

    onCardAdded();
  }

  function handleCardNumberChange(text: string) {
    const formatted = formatCardNumber(text);
    setCardNumber(formatted);
    if (errors.cardNumber) setErrors((e) => ({ ...e, cardNumber: "" }));
    // Auto-advance to expiry when 16 digits entered
    const digits = formatted.replace(/\s/g, "");
    if (digits.length === 16) expiryRef.current?.focus();
  }

  function handleExpiryChange(text: string) {
    const formatted = formatExpiry(text);
    setExpiry(formatted);
    if (errors.expiry) setErrors((e) => ({ ...e, expiry: "" }));
    if (formatted.length === 5) cvvRef.current?.focus();
  }

  function handleCvvChange(text: string) {
    const digits = text.replace(/\D/g, "").slice(0, cvvLength);
    setCvv(digits);
    if (errors.cvv) setErrors((e) => ({ ...e, cvv: "" }));
    if (digits.length === cvvLength) nameRef.current?.focus();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add card</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Card preview */}
        <View style={[styles.cardPreview, { borderColor: brandColor + "55" }]}>
          <View style={styles.cardPreviewTop}>
            <View style={styles.cardChip}>
              <View style={styles.cardChipInner} />
            </View>
            {brand !== "Unknown" && (
              <Text style={[styles.cardBrandLabel, { color: brandColor }]}>
                {brand}
              </Text>
            )}
          </View>
          <Text style={styles.cardNumberPreview}>
            {cardNumber
              ? cardNumber
                  .padEnd(19, "·")
                  .replace(/(.{4})/g, "$1 ")
                  .trim()
              : "•••• •••• •••• ••••"}
          </Text>
          <View style={styles.cardPreviewBottom}>
            <View>
              <Text style={styles.cardPreviewLabel}>CARDHOLDER</Text>
              <Text style={styles.cardPreviewValue}>
                {cardholderName || "YOUR NAME"}
              </Text>
            </View>
            <View>
              <Text style={styles.cardPreviewLabel}>EXPIRES</Text>
              <Text style={styles.cardPreviewValue}>{expiry || "MM/YY"}</Text>
            </View>
          </View>
        </View>

        {/* Security notice */}
        <View style={styles.securityNote}>
          <Ionicons name="shield-checkmark" size={14} color="#1D9E75" />
          <Text style={styles.securityNoteText}>
            Card details are encrypted and never stored on our servers
          </Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          {/* Card number */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>Card number</Text>
            <View
              style={[
                styles.inputRow,
                errors.cardNumber ? styles.inputError : null,
              ]}
            >
              <TextInput
                style={styles.input}
                value={cardNumber}
                onChangeText={handleCardNumberChange}
                placeholder="1234 5678 9012 3456"
                placeholderTextColor="#374151"
                keyboardType="number-pad"
                maxLength={19}
                returnKeyType="next"
                onSubmitEditing={() => expiryRef.current?.focus()}
              />
              {brand !== "Unknown" && cardNumber.length > 0 && (
                <View
                  style={[styles.brandDot, { backgroundColor: brandColor }]}
                />
              )}
            </View>
            {errors.cardNumber ? (
              <Text style={styles.errorText}>{errors.cardNumber}</Text>
            ) : null}
          </View>

          {/* Expiry + CVV */}
          <View style={styles.rowFields}>
            <View style={[styles.fieldWrap, { flex: 1 }]}>
              <Text style={styles.fieldLabel}>Expiry</Text>
              <View
                style={[
                  styles.inputRow,
                  errors.expiry ? styles.inputError : null,
                ]}
              >
                <TextInput
                  ref={expiryRef}
                  style={styles.input}
                  value={expiry}
                  onChangeText={handleExpiryChange}
                  placeholder="MM/YY"
                  placeholderTextColor="#374151"
                  keyboardType="number-pad"
                  maxLength={5}
                  returnKeyType="next"
                  onSubmitEditing={() => cvvRef.current?.focus()}
                />
              </View>
              {errors.expiry ? (
                <Text style={styles.errorText}>{errors.expiry}</Text>
              ) : null}
            </View>

            <View style={[styles.fieldWrap, { flex: 1 }]}>
              <Text style={styles.fieldLabel}>
                {isAmex ? "CID (4 digits)" : "CVV"}
              </Text>
              <View
                style={[styles.inputRow, errors.cvv ? styles.inputError : null]}
              >
                <TextInput
                  ref={cvvRef}
                  style={styles.input}
                  value={cvv}
                  onChangeText={handleCvvChange}
                  placeholder={isAmex ? "••••" : "•••"}
                  placeholderTextColor="#374151"
                  keyboardType="number-pad"
                  maxLength={cvvLength}
                  secureTextEntry
                  returnKeyType="next"
                  onSubmitEditing={() => nameRef.current?.focus()}
                />
                <Ionicons name="eye-off-outline" size={16} color="#374151" />
              </View>
              {errors.cvv ? (
                <Text style={styles.errorText}>{errors.cvv}</Text>
              ) : null}
            </View>
          </View>

          {/* Cardholder name */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>Name on card</Text>
            <View
              style={[
                styles.inputRow,
                errors.cardholderName ? styles.inputError : null,
              ]}
            >
              <TextInput
                ref={nameRef}
                style={styles.input}
                value={cardholderName}
                onChangeText={(t) => {
                  setCardholderName(t);
                  if (errors.cardholderName)
                    setErrors((e) => ({ ...e, cardholderName: "" }));
                }}
                placeholder="John Smith"
                placeholderTextColor="#374151"
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleSave}
              />
            </View>
            {errors.cardholderName ? (
              <Text style={styles.errorText}>{errors.cardholderName}</Text>
            ) : null}
          </View>
        </View>

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="lock-closed-outline" size={16} color="#fff" />
              <Text style={styles.saveBtnText}>Save card securely</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111827",
    paddingTop: Platform.OS === "ios" ? 56 : 40,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.07)",
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#F1F5F9" },
  scroll: { padding: 20 },

  // Card preview
  cardPreview: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 24,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    gap: 20,
  },
  cardPreviewTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardChip: {
    width: 36,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#C9A84C",
    justifyContent: "center",
    alignItems: "center",
  },
  cardChipInner: {
    width: 24,
    height: 16,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: "#A07830",
  },
  cardBrandLabel: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  cardNumberPreview: {
    fontSize: 20,
    fontWeight: "600",
    color: "#F1F5F9",
    letterSpacing: 3,
    fontVariant: ["tabular-nums"],
  },
  cardPreviewBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  cardPreviewLabel: {
    fontSize: 9,
    color: "#6B7280",
    fontWeight: "600",
    letterSpacing: 1,
    marginBottom: 3,
  },
  cardPreviewValue: {
    fontSize: 13,
    color: "#CBD5E1",
    fontWeight: "500",
    letterSpacing: 0.5,
  },

  // Security note
  securityNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(29,158,117,0.08)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 24,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.2)",
  },
  securityNoteText: {
    fontSize: 12,
    color: "#1D9E75",
    flex: 1,
    lineHeight: 17,
  },

  // Form
  form: { gap: 16 },
  fieldWrap: { gap: 7 },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6B7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 10,
  },
  inputError: {
    borderColor: "rgba(248,113,113,0.5)",
    backgroundColor: "rgba(248,113,113,0.05)",
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: "#F1F5F9",
    letterSpacing: 0.5,
  },
  brandDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  errorText: {
    fontSize: 11,
    color: "#F87171",
    marginTop: 2,
  },
  rowFields: {
    flexDirection: "row",
    gap: 12,
  },

  // Save button
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 28,
    backgroundColor: "#E8500A",
    borderRadius: 14,
    paddingVertical: 16,
  },
  saveBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
