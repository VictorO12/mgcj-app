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
  ScrollView,
} from "react-native";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface Props {
  onComplete: () => void;
}

// Strips non-alphanumeric, uppercases, then inserts a space after the 3rd
// character (NS: ABC 123) or 4th character (ON: ABCD 123), auto-detected
// by total alphanumeric length once the driver reaches 7 characters.
function formatPlate(input: string): string {
  const raw = input.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 7);
  if (raw.length <= 3) return raw;
  if (raw.length <= 6) return `${raw.slice(0, 3)} ${raw.slice(3)}`;
  return `${raw.slice(0, 4)} ${raw.slice(4)}`;
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

const VEHICLE_MODELS: Record<string, string[]> = {
  Toyota:     ["Avalon", "Camry", "Corolla", "Crown", "Highlander", "Prius", "RAV4", "Sienna", "Tacoma", "Tundra", "Venza"],
  Honda:      ["Accord", "Civic", "CR-V", "HR-V", "Odyssey", "Passport", "Pilot", "Ridgeline"],
  Ford:       ["Edge", "Escape", "Expedition", "Explorer", "F-150", "Fusion", "Maverick", "Taurus", "Transit"],
  Chevrolet:  ["Blazer", "Colorado", "Equinox", "Impala", "Malibu", "Silverado 1500", "Suburban", "Tahoe", "Traverse", "Trax"],
  Dodge:      ["Challenger", "Charger", "Durango", "Grand Caravan", "Journey"],
  Nissan:     ["Altima", "Armada", "Frontier", "Kicks", "Maxima", "Murano", "Pathfinder", "Rogue", "Sentra", "Titan", "Versa"],
  Hyundai:    ["Elantra", "Ioniq 5", "Ioniq 6", "Kona", "Palisade", "Santa Fe", "Sonata", "Tucson", "Venue"],
  Kia:        ["Carnival", "EV6", "Forte", "K5", "Seltos", "Soul", "Sorento", "Sportage", "Stinger", "Telluride"],
  Mazda:      ["CX-30", "CX-5", "CX-50", "CX-9", "Mazda3", "Mazda6", "MX-5"],
  Subaru:     ["Ascent", "Crosstrek", "Forester", "Impreza", "Legacy", "Outback", "WRX"],
  GMC:        ["Acadia", "Canyon", "Sierra 1500", "Sierra 2500", "Terrain", "Yukon"],
  RAM:        ["1500", "2500", "3500", "ProMaster City"],
  Jeep:       ["Cherokee", "Compass", "Gladiator", "Grand Cherokee", "Renegade", "Wrangler"],
  Volkswagen: ["Atlas", "Golf", "ID.4", "Jetta", "Passat", "Tiguan"],
  Other:      [],
};

export default function DriverSetupScreen({ onComplete }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [year, setYear] = useState("");
  const [showMakePicker, setShowMakePicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
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
                      if (make !== vehicleMake) {
                        setVehicleModel("");
                        setShowModelPicker(false);
                      }
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
            {vehicleMake === "Other" ? (
              <TextInput
                style={styles.input}
                placeholder="Enter model"
                placeholderTextColor={colors.textMuted}
                value={vehicleModel}
                onChangeText={setVehicleModel}
                autoCapitalize="words"
              />
            ) : (
              <>
                <TouchableOpacity
                  style={styles.selectBtn}
                  onPress={() => vehicleMake && setShowModelPicker((v) => !v)}
                  activeOpacity={0.8}
                  disabled={!vehicleMake}
                >
                  <Text style={[styles.selectText, !vehicleModel && styles.placeholder]}>
                    {vehicleModel || (vehicleMake ? "Select model" : "Select a make first")}
                  </Text>
                  <Text style={styles.chevron}>{showModelPicker ? "▲" : "▼"}</Text>
                </TouchableOpacity>
                {showModelPicker && (
                  <View style={styles.picker}>
                    {(VEHICLE_MODELS[vehicleMake] ?? []).map((model) => (
                      <TouchableOpacity
                        key={model}
                        style={[styles.pickerItem, vehicleModel === model && styles.pickerItemSelected]}
                        onPress={() => { setVehicleModel(model); setShowModelPicker(false); }}
                      >
                        <Text style={[styles.pickerItemText, vehicleModel === model && styles.pickerItemTextSelected]}>
                          {model}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            )}
          </View>

          {/* Year */}
          <View style={styles.inputWrap}>
            <Text style={styles.label}>
              Year <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 2019"
              placeholderTextColor={colors.textMuted}
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
              placeholderTextColor={colors.textMuted}
              value={plateNumber}
              onChangeText={(t) => setPlateNumber(formatPlate(t))}
              autoCapitalize="characters"
              maxLength={8}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
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
      color: colors.textPrimary,
      marginBottom: 8,
      textAlign: "center",
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      lineHeight: 20,
      textAlign: "center",
    },

    form: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      padding: 20,
      borderWidth: 0.5,
      borderColor: colors.border,
      gap: 16,
      marginBottom: 16,
    },
    inputWrap: { gap: 6 },
    label: {
      fontSize: 12,
      fontWeight: "500",
      color: colors.textTertiary,
      letterSpacing: 0.04,
    },
    optional: { color: colors.textMuted, fontWeight: "400" },
    input: {
      backgroundColor: colors.background,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 13,
      fontSize: 15,
      color: colors.textPrimary,
    },
    plateInput: {
      fontSize: 18,
      fontWeight: "600",
      letterSpacing: 0.15,
      textAlign: "center",
    },

    selectBtn: {
      backgroundColor: colors.background,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 13,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    selectText: { fontSize: 15, color: colors.textPrimary },
    placeholder: { color: colors.textMuted },
    chevron: { fontSize: 11, color: colors.textSecondary },
    picker: {
      backgroundColor: colors.background,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      marginTop: 4,
      overflow: "hidden",
    },
    pickerItem: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.borderSubtle,
    },
    pickerItemSelected: { backgroundColor: "rgba(29,158,117,0.1)" },
    pickerItemText: { fontSize: 14, color: colors.textOnSurfaceLight },
    pickerItemTextSelected: { color: colors.accentGreen, fontWeight: "600" },

    previewCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.25)",
      marginBottom: 16,
    },
    previewLabel: {
      fontSize: 11,
      color: colors.textSecondary,
      marginBottom: 12,
      textAlign: "center",
    },
    previewRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    previewAvatar: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.accentOrange,
    },
    previewInitials: { fontSize: 14, fontWeight: "700", color: colors.avatarText },
    previewName: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
    previewVehicle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

    btn: {
      backgroundColor: colors.accentGreen,
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: "center",
      marginBottom: 12,
    },
    btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
    note: { fontSize: 12, color: colors.textFaint, textAlign: "center" },
  });
