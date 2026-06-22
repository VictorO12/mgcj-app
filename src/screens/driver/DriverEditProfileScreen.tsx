import React, { useState, useEffect, useMemo } from "react";
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
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

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
        <ActivityIndicator color={colors.accentOrange} size="large" />
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
          <Ionicons name="arrow-back" size={22} color={colors.textPrimary} />
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
              placeholderTextColor={colors.textMuted}
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
                  !vehicleMake && { color: colors.textMuted },
                ]}
              >
                {vehicleMake || "Select make"}
              </Text>
              <Ionicons
                name={showMakePicker ? "chevron-up" : "chevron-down"}
                size={16}
                color={colors.textSecondary}
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
                    <Ionicons name="checkmark" size={16} color={colors.accentOrange} />
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
              placeholderTextColor={colors.textMuted}
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
              placeholderTextColor={colors.textMuted}
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
              placeholderTextColor={colors.textMuted}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    loadingContainer: {
      flex: 1,
      backgroundColor: colors.background,
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
      backgroundColor: colors.background,
      borderBottomWidth: 0.5,
      borderColor: colors.border,
    },
    backBtn: { padding: 4, width: 40 },
    headerTitle: { fontSize: 17, fontWeight: "600", color: colors.textPrimary },
    saveBtn: {
      backgroundColor: colors.accentOrange,
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
      borderColor: colors.accentOrange,
    },
    avatarFallback: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.accentOrange,
    },
    avatarInitials: { fontSize: 32, fontWeight: "700", color: colors.avatarText },
    avatarEditBadge: {
      position: "absolute",
      bottom: 0,
      right: 0,
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.background,
    },
    avatarHint: { fontSize: 13, color: colors.textSecondary },

    sectionLabel: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: 8,
      marginTop: 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
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
    fieldLabel: {
      width: 72,
      fontSize: 14,
      color: colors.textTertiary,
      fontWeight: "500",
    },
    fieldInput: {
      flex: 1,
      fontSize: 14,
      color: colors.textPrimary,
      textAlign: "right",
    },
    plateInput: { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
    fieldReadOnly: {
      flex: 1,
      fontSize: 14,
      color: colors.textMuted,
      textAlign: "right",
    },
    fieldDivider: {
      height: 0.5,
      backgroundColor: colors.borderSubtle,
      marginLeft: 16,
    },
    fieldNote: {
      fontSize: 12,
      color: colors.textMuted,
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
    picker: { borderTopWidth: 0.5, borderColor: colors.borderSubtle },
    pickerItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 11,
      paddingHorizontal: 20,
      borderBottomWidth: 0.5,
      borderColor: colors.borderSubtle,
    },
    pickerItemSelected: { backgroundColor: "rgba(232,80,10,0.08)" },
    pickerItemText: { fontSize: 14, color: colors.textTertiary },
    pickerItemTextSelected: { color: colors.accentOrange, fontWeight: "600" },

    previewCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.25)",
      marginTop: 8,
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
    previewAvatarImage: {
      width: 42,
      height: 42,
      borderRadius: 21,
      borderWidth: 1.5,
      borderColor: colors.accentOrange,
    },
    previewInitials: { fontSize: 14, fontWeight: "700", color: colors.avatarText },
    previewName: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
    previewVehicle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  });
