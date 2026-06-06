import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface Props {
  onClose: () => void;
}

const FAQ_ITEMS = [
  {
    q: "How do I go online to receive rides?",
    a: "From the home screen, tap 'Go online'. You'll start receiving ride requests in the Annapolis Valley as soon as you're online.",
  },
  {
    q: "What happens when I'm assigned a scheduled ride?",
    a: "You'll receive a push notification ahead of the pickup time. You can accept or decline the ride from the notification or the Assigned rides section in your profile menu.",
  },
  {
    q: "How are fares calculated?",
    a: "Fares are estimated based on distance and the company's rate. The final fare may differ slightly from the estimate depending on the actual route taken.",
  },
  {
    q: "What should I do if I can't complete a ride?",
    a: "Contact dispatch directly using the number below as soon as possible so they can reassign the ride to another driver.",
  },
  {
    q: "How do I update my vehicle information?",
    a: "Go to your profile menu and tap 'Edit profile'. You can update your vehicle make, model, year, and plate number there.",
  },
  {
    q: "Why am I not receiving notifications?",
    a: "Make sure notifications are enabled for this app in your phone's Settings. If the problem persists, try logging out and back in, or contact dispatch.",
  },
  {
    q: "How do I see my past rides and earnings?",
    a: "Tap 'Ride history' in your profile menu to view all completed trips.",
  },
];

export default function HelpSupportScreen({ onClose }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  function toggleFaq(i: number) {
    setOpenIndex(openIndex === i ? null : i);
  }

  function callDispatch() {
    Linking.openURL("tel:+19020000000");
  }

  function emailDispatch() {
    Linking.openURL("mailto:dispatch@mgcj.ca");
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={onClose}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Help & support</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.inner}
        showsVerticalScrollIndicator={false}
      >
        {/* Contact cards */}
        <Text style={styles.sectionLabel}>Contact dispatch</Text>
        <View style={styles.contactRow}>
          <TouchableOpacity
            style={styles.contactCard}
            onPress={callDispatch}
            activeOpacity={0.8}
          >
            <View style={styles.contactIconWrap}>
              <Ionicons name="call" size={20} color="#1D9E75" />
            </View>
            <Text style={styles.contactLabel}>Call</Text>
            <Text style={styles.contactValue}>(902) 000-0000</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.contactCard}
            onPress={emailDispatch}
            activeOpacity={0.8}
          >
            <View style={styles.contactIconWrap}>
              <Ionicons name="mail" size={20} color="#4a9eff" />
            </View>
            <Text style={styles.contactLabel}>Email</Text>
            <Text style={styles.contactValue}>dispatch@mgcj.ca</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.hoursCard}>
          <Ionicons name="time-outline" size={18} color="#6B7280" />
          <Text style={styles.hoursText}>
            Dispatch available <Text style={styles.hoursBold}>24 / 7</Text>
          </Text>
        </View>

        {/* FAQ */}
        <Text style={[styles.sectionLabel, { marginTop: 28 }]}>
          Frequently asked questions
        </Text>

        <View style={styles.faqCard}>
          {FAQ_ITEMS.map((item, i) => (
            <View key={i}>
              <TouchableOpacity
                style={styles.faqRow}
                onPress={() => toggleFaq(i)}
                activeOpacity={0.7}
              >
                <Text style={styles.faqQuestion}>{item.q}</Text>
                <Ionicons
                  name={openIndex === i ? "chevron-up" : "chevron-down"}
                  size={16}
                  color="#6B7280"
                />
              </TouchableOpacity>
              {openIndex === i && (
                <View style={styles.faqAnswer}>
                  <Text style={styles.faqAnswerText}>{item.a}</Text>
                </View>
              )}
              {i < FAQ_ITEMS.length - 1 && <View style={styles.faqDivider} />}
            </View>
          ))}
        </View>

        {/* Version */}
        <Text style={styles.versionText}>M&G C&J Driver App · v1.0</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 56 : 40,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  backBtn: { padding: 4, width: 40 },
  headerTitle: { fontSize: 17, fontWeight: "600", color: "#F1F5F9" },

  inner: { padding: 20, paddingBottom: 48 },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6B7280",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 12,
  },

  contactRow: { flexDirection: "row", gap: 12, marginBottom: 10 },
  contactCard: {
    flex: 1,
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 16,
    alignItems: "center",
    gap: 6,
  },
  contactIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  contactLabel: { fontSize: 12, color: "#6B7280" },
  contactValue: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F1F5F9",
    textAlign: "center",
  },

  hoursCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    padding: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  hoursText: { fontSize: 13, color: "#6B7280" },
  hoursBold: { color: "#F1F5F9", fontWeight: "600" },

  faqCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  faqRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    gap: 12,
  },
  faqQuestion: {
    flex: 1,
    fontSize: 14,
    color: "#F1F5F9",
    fontWeight: "500",
    lineHeight: 20,
  },
  faqAnswer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  faqAnswerText: {
    fontSize: 13,
    color: "#9CA3AF",
    lineHeight: 20,
  },
  faqDivider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginHorizontal: 16,
  },

  versionText: {
    fontSize: 12,
    color: "#374151",
    textAlign: "center",
    marginTop: 32,
  },
});
