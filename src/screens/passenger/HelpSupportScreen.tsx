import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Platform,
  LayoutAnimation,
  UIManager,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  onClose: () => void;
}

interface FAQ {
  q: string;
  a: string;
}

const FAQS: FAQ[] = [
  {
    q: "How do I book a ride?",
    a: "Enter your destination in the search bar on the home screen, confirm your pickup location, then tap 'Book ride'. A driver will be assigned shortly.",
  },
  {
    q: "How do I cancel a ride?",
    a: "While your ride is pending or a driver is assigned, tap the ride tracking card and select 'Cancel ride'. Cancellations are free before a driver is on their way.",
  },
  {
    q: "How is the fare calculated?",
    a: "Fares are estimated based on distance and time. The final fare is shown after your trip completes. Cash and card payments are both accepted.",
  },
  {
    q: "What if my driver doesn't arrive?",
    a: "If your driver is taking too long, you can contact them via the ride screen. If you can't reach them, cancel the ride and rebook — no charge applies.",
  },
  {
    q: "How do I update my name or photo?",
    a: "Tap your avatar at the top of the home screen, then go to Profile. From there you can update your name and add a profile picture.",
  },
  {
    q: "Is my payment information stored?",
    a: "M&G C&J does not store card details on device. All payment processing is handled securely through our payment partners.",
  },
];

export default function HelpSupportScreen({ onClose }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  function toggleFAQ(index: number) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIndex((prev) => (prev === index ? null : index));
  }

  function callSupport() {
    Linking.openURL("tel:+19025550100").catch(() => {});
  }

  function emailSupport() {
    Linking.openURL("mailto:support@mgcj.com?subject=App%20Support").catch(
      () => {},
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Help & Support</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Contact cards */}
        <Text style={styles.sectionLabel}>CONTACT US</Text>
        <View style={styles.contactRow}>
          <TouchableOpacity
            style={styles.contactCard}
            onPress={callSupport}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.contactIcon,
                { backgroundColor: "rgba(29,158,117,0.12)" },
              ]}
            >
              <Ionicons name="call-outline" size={22} color={colors.accentGreen} />
            </View>
            <Text style={styles.contactLabel}>Call us</Text>
            <Text style={styles.contactSub}>Mon–Sat, 8am–8pm</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.contactCard}
            onPress={emailSupport}
            activeOpacity={0.8}
          >
            <View
              style={[
                styles.contactIcon,
                { backgroundColor: "rgba(232,80,10,0.12)" },
              ]}
            >
              <Ionicons name="mail-outline" size={22} color={colors.accentOrange} />
            </View>
            <Text style={styles.contactLabel}>Email us</Text>
            <Text style={styles.contactSub}>Reply within 24h</Text>
          </TouchableOpacity>
        </View>

        {/* FAQ */}
        <Text style={[styles.sectionLabel, { marginTop: 24 }]}>
          FREQUENTLY ASKED
        </Text>
        <View style={styles.faqCard}>
          {FAQS.map((faq, i) => (
            <View key={i}>
              {i > 0 && <View style={styles.faqDivider} />}
              <TouchableOpacity
                style={styles.faqRow}
                onPress={() => toggleFAQ(i)}
                activeOpacity={0.7}
              >
                <Text style={styles.faqQuestion}>{faq.q}</Text>
                <Ionicons
                  name={expandedIndex === i ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
              {expandedIndex === i && (
                <Text style={styles.faqAnswer}>{faq.a}</Text>
              )}
            </View>
          ))}
        </View>

        {/* Version info */}
        <Text style={styles.versionText}>M&G C&J Rides · Version 1.0.0</Text>
      </ScrollView>
    </View>
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
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textMuted,
      letterSpacing: 0.08,
      marginBottom: 12,
    },
    contactRow: { flexDirection: "row", gap: 12 },
    contactCard: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
      padding: 16,
      alignItems: "center",
      gap: 8,
    },
    contactIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    contactLabel: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
    contactSub: { fontSize: 11, color: colors.textSecondary, textAlign: "center" },
    faqCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
      overflow: "hidden",
    },
    faqRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 16,
      gap: 12,
    },
    faqQuestion: {
      flex: 1,
      fontSize: 14,
      fontWeight: "500",
      color: colors.textPrimary,
      lineHeight: 20,
    },
    faqAnswer: {
      fontSize: 13,
      color: colors.textTertiary,
      lineHeight: 20,
      paddingHorizontal: 18,
      paddingBottom: 16,
    },
    faqDivider: {
      height: 0.5,
      backgroundColor: colors.borderSubtle,
      marginHorizontal: 18,
    },
    versionText: {
      fontSize: 12,
      color: colors.textFaint,
      textAlign: "center",
      marginTop: 32,
    },
  });
