import React, { useState, useEffect } from "react";
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
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface Props {
  onClose: () => void;
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

export default function DriverEditProfileScreen({ onClose }: Props) {
  const { profile, refetch } = useAuth();

  const [name, setName] = useState(profile?.name ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    profile?.avatar_url ?? null,
  );
  const [uploading, setUploading] = useState(false);
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [year, setYear] = useState("");
  const [showMakePicker, setShowMakePicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);

  const initials = name
    ? name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  useEffect(() => {
    loadDriverData();
  }, []);

  async function loadDriverData() {
    if (!profile) return;
    const { data } = await supabase
      .from("drivers")
      .select("vehicle_make, vehicle_model, plate_number, vehicle_year")
      .eq("id", profile.id)
      .single();
    if (data) {
      setVehicleMake(data.vehicle_make ?? "");
      setVehicleModel(data.vehicle_model ?? "");
      setPlateNumber(data.plate_number ?? "");
      setYear(data.vehicle_year ? String(data.vehicle_year) : "");
    }
    setLoadingData(false);
  }

  async function pickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow access to your photo library.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    await uploadAvatar(result.assets[0].uri);
  }

  async function uploadAvatar(uri: string) {
    if (!profile) return;
    setUploading(true);
    try {
      const filePath = `avatars/${profile.id}.jpg`;
      const formData = new FormData();
      formData.append("file", {
        uri,
        name: "avatar.jpg",
        type: "image/jpeg",
      } as any);

      const { error: uploadError } = await supabase.storage
        .from("profile-pictures")
        .upload(filePath, formData, {
          contentType: "image/jpeg",
          upsert: true,
        });

      if (uploadError) {
        Alert.alert("Upload failed", uploadError.message);
        return;
      }

      const { data: urlData } = supabase.storage
        .from("profile-pictures")
        .getPublicUrl(filePath);
      const cleanUrl = urlData.publicUrl;
      const displayUrl = `${cleanUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: cleanUrl })
        .eq("id", profile.id);

      if (updateError) {
        Alert.alert("Save failed", updateError.message);
        return;
      }

      setAvatarUrl(displayUrl);
      await refetch();
    } catch {
      Alert.alert("Error", "Failed to upload image. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      Alert.alert("Missing info", "Please enter your name.");
      return;
    }
    if (!vehicleMake.trim()) {
      Alert.alert("Missing info", "Please select your vehicle make.");
      return;
    }
    if (!vehicleModel.trim()) {
      Alert.alert("Missing info", "Please enter your vehicle model.");
      return;
    }
    if (!plateNumber.trim()) {
      Alert.alert("Missing info", "Please enter your license plate.");
      return;
    }
    if (!profile) return;

    setLoading(true);
    const [profileRes, driverRes] = await Promise.all([
      supabase
        .from("profiles")
        .update({ name: name.trim() })
        .eq("id", profile.id),
      supabase
        .from("drivers")
        .update({
          vehicle_make: vehicleMake.trim(),
          vehicle_model: vehicleModel.trim(),
          plate_number: plateNumber.trim().toUpperCase(),
          ...(year.trim() ? { vehicle_year: parseInt(year.trim()) } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile.id),
    ]);
    setLoading(false);

    if (profileRes.error || driverRes.error) {
      Alert.alert("Error", "Failed to save changes. Please try again.");
      return;
    }

    await refetch();
    onClose();
  }

  if (loadingData) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#E8500A" size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={onClose}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit profile</Text>
        <TouchableOpacity
          style={[styles.saveBtn, loading && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <TouchableOpacity
            style={styles.avatarWrap}
            onPress={pickImage}
            activeOpacity={0.8}
            disabled={uploading}
          >
            {avatarUrl ? (
              <Image
                source={{ uri: avatarUrl }}
                style={styles.avatarImage}
                onError={() => setAvatarUrl(null)}
              />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
            )}
            <View style={styles.avatarEditBadge}>
              {uploading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="camera" size={14} color="#fff" />
              )}
            </View>
          </TouchableOpacity>
          <Text style={styles.avatarHint}>
            {uploading ? "Uploading..." : "Tap to change photo"}
          </Text>
        </View>

        {/* Personal info section */}
        <Text style={styles.sectionLabel}>Personal info</Text>
        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Full name</Text>
            <TextInput
              style={styles.fieldInput}
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor="#4B5563"
              autoCapitalize="words"
            />
          </View>
          <View style={styles.fieldDivider} />
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Phone</Text>
            <Text style={styles.fieldReadOnly}>{profile?.phone ?? ""}</Text>
          </View>
        </View>
        <Text style={styles.fieldNote}>
          Phone number cannot be changed here. Contact dispatch if needed.
        </Text>

        {/* Vehicle section */}
        <Text style={styles.sectionLabel}>Vehicle details</Text>
        <View style={styles.card}>
          {/* Make */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Make</Text>
            <TouchableOpacity
              style={styles.selectRow}
              onPress={() => setShowMakePicker(!showMakePicker)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.fieldInput,
                  !vehicleMake && { color: "#4B5563" },
                ]}
              >
                {vehicleMake || "Select make"}
              </Text>
              <Ionicons
                name={showMakePicker ? "chevron-up" : "chevron-down"}
                size={16}
                color="#6B7280"
              />
            </TouchableOpacity>
          </View>

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
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.pickerItemText,
                      vehicleMake === make && styles.pickerItemTextSelected,
                    ]}
                  >
                    {make}
                  </Text>
                  {vehicleMake === make && (
                    <Ionicons name="checkmark" size={16} color="#E8500A" />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.fieldDivider} />

          {/* Model */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Model</Text>
            <TextInput
              style={styles.fieldInput}
              value={vehicleModel}
              onChangeText={setVehicleModel}
              placeholder="e.g. Camry, Civic"
              placeholderTextColor="#4B5563"
              autoCapitalize="words"
            />
          </View>
          <View style={styles.fieldDivider} />

          {/* Year */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Year</Text>
            <TextInput
              style={styles.fieldInput}
              value={year}
              onChangeText={setYear}
              placeholder="e.g. 2019 (optional)"
              placeholderTextColor="#4B5563"
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>
          <View style={styles.fieldDivider} />

          {/* Plate */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Plate</Text>
            <TextInput
              style={[styles.fieldInput, styles.plateInput]}
              value={plateNumber}
              onChangeText={(t) => setPlateNumber(t.toUpperCase())}
              placeholder="ABC 123"
              placeholderTextColor="#4B5563"
              autoCapitalize="characters"
              maxLength={10}
            />
          </View>
        </View>

        {/* Preview */}
        {vehicleMake && vehicleModel && plateNumber && (
          <View style={styles.previewCard}>
            <Text style={styles.previewLabel}>How passengers see you</Text>
            <View style={styles.previewRow}>
              {avatarUrl ? (
                <Image
                  source={{ uri: avatarUrl }}
                  style={styles.previewAvatarImage}
                />
              ) : (
                <View style={styles.previewAvatar}>
                  <Text style={styles.previewInitials}>{initials}</Text>
                </View>
              )}
              <View>
                <Text style={styles.previewName}>{name || "Driver"}</Text>
                <Text style={styles.previewVehicle}>
                  {year ? `${year} ` : ""}
                  {vehicleMake} {vehicleModel} · {plateNumber}
                </Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  loadingContainer: {
    flex: 1,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 56 : 40,
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: "#111827",
    borderBottomWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  backBtn: { padding: 4, width: 40 },
  headerTitle: { fontSize: 17, fontWeight: "600", color: "#F1F5F9" },
  saveBtn: {
    backgroundColor: "#E8500A",
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 16,
    width: 70,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },

  inner: { padding: 20, paddingBottom: 48 },

  avatarSection: { alignItems: "center", marginBottom: 28 },
  avatarWrap: { position: "relative", marginBottom: 10 },
  avatarImage: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderColor: "#E8500A",
  },
  avatarFallback: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#E8500A",
  },
  avatarInitials: { fontSize: 32, fontWeight: "700", color: "#93C5FD" },
  avatarEditBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#E8500A",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#111827",
  },
  avatarHint: { fontSize: 13, color: "#6B7280" },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6B7280",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
  },
  card: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 8,
    overflow: "hidden",
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  fieldLabel: { width: 72, fontSize: 14, color: "#9CA3AF", fontWeight: "500" },
  fieldInput: { flex: 1, fontSize: 14, color: "#F1F5F9", textAlign: "right" },
  plateInput: { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
  fieldReadOnly: {
    flex: 1,
    fontSize: 14,
    color: "#4B5563",
    textAlign: "right",
  },
  fieldDivider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginLeft: 16,
  },
  fieldNote: {
    fontSize: 12,
    color: "#4B5563",
    marginBottom: 20,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  selectRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
  },
  picker: { borderTopWidth: 0.5, borderColor: "rgba(255,255,255,0.06)" },
  pickerItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderBottomWidth: 0.5,
    borderColor: "rgba(255,255,255,0.04)",
  },
  pickerItemSelected: { backgroundColor: "rgba(232,80,10,0.08)" },
  pickerItemText: { fontSize: 14, color: "#9CA3AF" },
  pickerItemTextSelected: { color: "#E8500A", fontWeight: "600" },

  previewCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.25)",
    marginTop: 8,
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
  previewAvatarImage: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  previewInitials: { fontSize: 14, fontWeight: "700", color: "#93C5FD" },
  previewName: { fontSize: 14, fontWeight: "600", color: "#F1F5F9" },
  previewVehicle: { fontSize: 12, color: "#6B7280", marginTop: 2 },
});
