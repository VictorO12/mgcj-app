import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  CardField,
  useStripe,
  CardFieldInput,
} from "@stripe/stripe-react-native";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import Constants from "expo-constants";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl;
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey;

interface Props {
  onClose: () => void;
  onCardAdded: () => void;
}

export default function AddCardScreen({ onClose, onCardAdded }: Props) {
  const { profile } = useAuth();
  const { createPaymentMethod } = useStripe();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [cardDetails, setCardDetails] = useState<CardFieldInput.Details | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  const isComplete = cardDetails?.complete ?? false;

  async function handleSave() {
    if (!isComplete || !profile) return;
    setSaving(true);

    try {
      // ── Step 1: Create a PaymentMethod token via Stripe ────────
      const { paymentMethod, error: pmError } = await createPaymentMethod({
        paymentMethodType: "Card",
        paymentMethodData: {
          billingDetails: {
            name: profile.name ?? undefined,
            phone: profile.phone ?? undefined,
          },
        },
      });

      if (pmError || !paymentMethod) {
        setSaving(false);
        Alert.alert(
          "Card error",
          pmError?.message ?? "Could not process card.",
        );
        return;
      }

      // ── Step 2: Send pm_xxx to our Edge Function ────────────────
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setSaving(false);
        Alert.alert("Error", "Session expired. Please sign in again.");
        return;
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/save-card`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ payment_method_id: paymentMethod.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaving(false);
        Alert.alert("Error saving card", data.error ?? "Please try again.");
        return;
      }

      setSaving(false);
      onCardAdded();
    } catch (err) {
      console.error("Save card error:", err);
      setSaving(false);
      Alert.alert("Error", "Something went wrong. Please try again.");
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add card</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Info banner */}
        <View style={styles.infoBanner}>
          <Ionicons name="shield-checkmark" size={20} color={colors.accentGreen} />
          <View style={{ flex: 1 }}>
            <Text style={styles.infoBannerTitle}>Secured by Stripe</Text>
            <Text style={styles.infoBannerSub}>
              Your card details are encrypted and never stored on our servers.
              Stripe handles all payment security.
            </Text>
          </View>
        </View>

        {/* Card field */}
        <View style={styles.cardFieldWrap}>
          <Text style={styles.fieldLabel}>Card details</Text>
          <CardField
            postalCodeEnabled={false}
            placeholders={{ number: "1234 5678 9012 3456" }}
            cardStyle={{
              backgroundColor: colors.surface,
              textColor: colors.textPrimary,
              placeholderColor: colors.textMuted,
              borderColor: colors.border,
              borderWidth: 0.5,
              borderRadius: 12,
              cursorColor: colors.accentOrange,
              fontSize: 16,
            }}
            style={styles.cardField}
            onCardChange={(details) => setCardDetails(details)}
          />
          {isComplete && (
            <View style={styles.cardCompleteRow}>
              <Ionicons name="checkmark-circle" size={14} color={colors.accentGreen} />
              <Text style={styles.cardCompleteText}>
                Card details look good
              </Text>
            </View>
          )}
        </View>

        {/* What happens next */}
        <View style={styles.explainerCard}>
          <Text style={styles.explainerTitle}>How card payments work</Text>
          <View style={styles.explainerRow}>
            <View style={styles.explainerDot} />
            <Text style={styles.explainerText}>
              When you book a ride, your card is authorized for the estimated
              fare
            </Text>
          </View>
          <View style={styles.explainerRow}>
            <View style={styles.explainerDot} />
            <Text style={styles.explainerText}>
              The actual charge happens automatically when your ride completes
            </Text>
          </View>
          <View style={styles.explainerRow}>
            <View style={styles.explainerDot} />
            <Text style={styles.explainerText}>
              You can always switch to cash at booking time
            </Text>
          </View>
        </View>

        {/* Save button */}
        <TouchableOpacity
          style={[
            styles.saveBtn,
            (!isComplete || saving) && styles.saveBtnDisabled,
          ]}
          onPress={handleSave}
          disabled={!isComplete || saving}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
      paddingTop: Platform.OS === "ios" ? 56 : 40,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
    scroll: { padding: 20, gap: 20 },

    infoBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      backgroundColor: "rgba(29,158,117,0.08)",
      borderRadius: 14,
      padding: 14,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.2)",
    },
    infoBannerTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.accentGreen,
      marginBottom: 3,
    },
    infoBannerSub: {
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 17,
    },

    cardFieldWrap: { gap: 10 },
    fieldLabel: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    cardField: {
      width: "100%",
      height: 50,
    },
    cardCompleteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 2,
    },
    cardCompleteText: {
      fontSize: 12,
      color: colors.accentGreen,
      fontWeight: "500",
    },

    explainerCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
      gap: 10,
    },
    explainerTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 2,
    },
    explainerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    explainerDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accentOrange,
      marginTop: 5,
      flexShrink: 0,
    },
    explainerText: {
      fontSize: 13,
      color: colors.textTertiary,
      flex: 1,
      lineHeight: 19,
    },

    saveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: colors.accentOrange,
      borderRadius: 14,
      paddingVertical: 16,
    },
    saveBtnDisabled: {
      opacity: 0.4,
    },
    saveBtnText: {
      color: "#fff",
      fontSize: 16,
      fontWeight: "600",
    },
  });
