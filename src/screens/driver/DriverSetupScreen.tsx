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
  ScrollView,
} from "react-native";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface Props {
  onComplete: () => void;
}

const VEHICLE_MAKES = [
  "Toyota",
  "Honda",
  "Ford",
  "Chevrolet",
  "Dodge",
  "Nissan",
  "Hyundai",
  "Kia",
  "Mazda",
  "Subaru",
  "GMC",
  "RAM",
  "Jeep",
  "Volkswagen",
  "Other",
];

export default function DriverSetupScreen({ onComplete }: Props) {
  const { profile } = useAuth();
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [year, setYear] = useState("");
  const [showMakePicker, setShowMakePicker] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleComplete() {
    if (!vehicleMake.trim()) {
      Alert.alert("Missing info", "Please select your vehicle make.");
      return;
    }
    if (!vehicleModel.trim()) {
      Alert.alert("Missing info", "Please enter your vehicle model.");
      return;
    }
    if (!plateNumber.trim()) {
      Alert.alert("Missing info", "Please enter your license plate number.");
      return;
    }
    if (!profile) return;

    setLoading(true);
    const { error } = await supabase
      .from("drivers")
      .update({
        vehicle_make: vehicleMake.trim(),
        vehicle_model: vehicleModel.trim(),
        plate_number: plateNumber.trim().toUpperCase(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile.id);

    setLoading(false);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    onComplete();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.emoji}>🚗</Text>
          <Text style={styles.title}>Set up your vehicle</Text>
          <Text style={styles.subtitle}>
            This information is shown to passengers when you accept a ride.
          </Text>
        </View>

        <View style={styles.form}>
          {/* Vehicle make */}
          <View style={styles.inputWrap}>
            <Text style={styles.label}>Vehicle make</Text>
            <TouchableOpacity
              style={styles.selectBtn}
              onPress={() => setShowMakePicker(!showMakePicker)}
              activeOpacity={0.8}
            >
              <Text
                style={[styles.selectText, !vehicleMake && styles.placeholder]}
              >
                {vehicleMake || "Select make"}
              </Text>
              <Text style={styles.chevron}>{showMakePicker ? "▲" : "▼"}</Text>
            </TouchableOpacity>
            {showMakePicker && (
              <View style={styles.picker}>
                {VEHICLE_MAKES.map((make) => (
                  <TouchableOpacity
                    key={make}
                    style={[
                      styles.pickerItem,
                      vehicleMake === make && styles.pickerItemSelected,
                    ]}
                    onPress={() => {
                      setVehicleMake(make);
                      setShowMakePicker(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.pickerItemText,
                        vehicleMake === make && styles.pickerItemTextSelected,
                      ]}
                    >
                      {make}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          {/* Vehicle model */}
          <View style={styles.inputWrap}>
            <Text style={styles.label}>Vehicle model</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Camry, Civic, F-150"
              placeholderTextColor="#4B5563"
              value={vehicleModel}
              onChangeText={setVehicleModel}
              autoCapitalize="words"
            />
          </View>

          {/* Year */}
          <View style={styles.inputWrap}>
            <Text style={styles.label}>
              Year <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 2019"
              placeholderTextColor="#4B5563"
              value={year}
              onChangeText={setYear}
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>

          {/* Plate number */}
          <View style={styles.inputWrap}>
            <Text style={styles.label}>License plate</Text>
            <TextInput
              style={[styles.input, styles.plateInput]}
              placeholder="ABC 123"
              placeholderTextColor="#4B5563"
              value={plateNumber}
              onChangeText={(t) => setPlateNumber(t.toUpperCase())}
              autoCapitalize="characters"
              maxLength={10}
            />
          </View>
        </View>

        {/* Preview card */}
        {vehicleMake && vehicleModel && plateNumber && (
          <View style={styles.previewCard}>
            <Text style={styles.previewLabel}>
              How passengers will see your vehicle
            </Text>
            <View style={styles.previewRow}>
              <View style={styles.previewAvatar}>
                <Text style={styles.previewInitials}>
                  {profile?.name
                    ?.split(" ")
                    .map((n) => n[0])
                    .join("")
                    .slice(0, 2) ?? "D"}
                </Text>
              </View>
              <View>
                <Text style={styles.previewName}>
                  {profile?.name ?? "Driver"}
                </Text>
                <Text style={styles.previewVehicle}>
                  {year ? `${year} ` : ""}
                  {vehicleMake} {vehicleModel} · {plateNumber}
                </Text>
              </View>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={[styles.btn, loading && { opacity: 0.6 }]}
          onPress={handleComplete}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>Complete setup</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.note}>
          You can update these details later from your profile.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  inner: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "ios" ? 60 : 40,
    paddingBottom: 40,
  },
  header: { alignItems: "center", marginBottom: 32 },
  emoji: { fontSize: 48, marginBottom: 12 },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 20,
    textAlign: "center",
  },

  form: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 16,
    marginBottom: 16,
  },
  inputWrap: { gap: 6 },
  label: {
    fontSize: 12,
    fontWeight: "500",
    color: "#9CA3AF",
    letterSpacing: 0.04,
  },
  optional: { color: "#4B5563", fontWeight: "400" },
  input: {
    backgroundColor: "#111827",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: "#F1F5F9",
  },
  plateInput: {
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 0.15,
    textAlign: "center",
  },

  selectBtn: {
    backgroundColor: "#111827",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  selectText: { fontSize: 15, color: "#F1F5F9" },
  placeholder: { color: "#4B5563" },
  chevron: { fontSize: 11, color: "#6B7280" },
  picker: {
    backgroundColor: "#111827",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    marginTop: 4,
    overflow: "hidden",
  },
  pickerItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  pickerItemSelected: { backgroundColor: "rgba(29,158,117,0.1)" },
  pickerItemText: { fontSize: 14, color: "#CBD5E1" },
  pickerItemTextSelected: { color: "#1D9E75", fontWeight: "600" },

  previewCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.25)",
    marginBottom: 16,
  },
  previewLabel: {
    fontSize: 11,
    color: "#6B7280",
    marginBottom: 12,
    textAlign: "center",
  },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  previewAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  previewInitials: { fontSize: 14, fontWeight: "700", color: "#93C5FD" },
  previewName: { fontSize: 14, fontWeight: "600", color: "#F1F5F9" },
  previewVehicle: { fontSize: 12, color: "#6B7280", marginTop: 2 },

  btn: {
    backgroundColor: "#1D9E75",
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    marginBottom: 12,
  },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  note: { fontSize: 12, color: "#374151", textAlign: "center" },
});
