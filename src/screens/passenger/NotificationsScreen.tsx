import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface Props {
  onClose: () => void;
}

interface NotifSetting {
  id: string;
  icon: string;
  label: string;
  description: string;
  enabled: boolean;
}

export default function NotificationsScreen({ onClose }: Props) {
  const [settings, setSettings] = useState<NotifSetting[]>([
    {
      id: "ride_updates",
      icon: "car-outline",
      label: "Ride updates",
      description: "Driver assigned, arriving, and trip status changes",
      enabled: true,
    },
    {
      id: "driver_arriving",
      icon: "navigate-outline",
      label: "Driver arriving",
      description: "Alert when your driver is nearby",
      enabled: true,
    },
    {
      id: "trip_complete",
      icon: "checkmark-circle-outline",
      label: "Trip completed",
      description: "Receipt and trip summary after each ride",
      enabled: true,
    },
    {
      id: "promotions",
      icon: "pricetag-outline",
      label: "Offers & promotions",
      description: "Discounts and special deals from M&G",
      enabled: false,
    },
    {
      id: "account",
      icon: "shield-outline",
      label: "Account activity",
      description: "Sign-in alerts and account changes",
      enabled: true,
    },
  ]);

  function toggle(id: string) {
    setSettings((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  }

  function saveSettings() {
    Alert.alert("Saved", "Notification preferences updated.");
    onClose();
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>
          Choose which notifications you'd like to receive.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>NOTIFICATION PREFERENCES</Text>
          {settings.map((setting, i) => (
            <View key={setting.id}>
              {i > 0 && <View style={styles.itemDivider} />}
              <View style={styles.settingRow}>
                <View style={styles.settingIcon}>
                  <Ionicons
                    name={setting.icon as any}
                    size={18}
                    color={setting.enabled ? "#E8500A" : "#6B7280"}
                  />
                </View>
                <View style={styles.settingText}>
                  <Text style={styles.settingLabel}>{setting.label}</Text>
                  <Text style={styles.settingDesc}>{setting.description}</Text>
                </View>
                <Switch
                  value={setting.enabled}
                  onValueChange={() => toggle(setting.id)}
                  trackColor={{ false: "#374151", true: "rgba(232,80,10,0.4)" }}
                  thumbColor={setting.enabled ? "#E8500A" : "#6B7280"}
                  ios_backgroundColor="#374151"
                />
              </View>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={styles.saveBtn}
          onPress={saveSettings}
          activeOpacity={0.85}
        >
          <Text style={styles.saveBtnText}>Save preferences</Text>
        </TouchableOpacity>
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
    backgroundColor: "rgba(17,24,39,0.95)",
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.07)",
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 48 },
  intro: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 20,
    marginBottom: 20,
  },
  card: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 20,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    letterSpacing: 0.08,
    marginBottom: 14,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  settingText: { flex: 1 },
  settingLabel: { fontSize: 14, fontWeight: "500", color: "#F1F5F9" },
  settingDesc: { fontSize: 12, color: "#6B7280", marginTop: 2, lineHeight: 16 },
  itemDivider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginVertical: 2,
  },
  saveBtn: {
    backgroundColor: "#E8500A",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
