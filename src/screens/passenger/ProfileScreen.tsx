import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ScrollView,
  ActivityIndicator,
  Image,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface Props {
  onClose: () => void;
  onDeleteAccount: () => void;
}

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export default function ProfileScreen({ onClose, onDeleteAccount }: Props) {
  const { profile, refetch, signOut } = useAuth();
  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    profile?.avatar_url ?? null,
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const initials = name
    ? name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

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
    } catch (err) {
      Alert.alert("Error", "Failed to upload image. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function saveProfile() {
    if (!profile) return;
    if (!name.trim()) {
      Alert.alert("Name required", "Please enter your name.");
      return;
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail && !EMAIL_REGEX.test(trimmedEmail)) {
      Alert.alert(
        "Invalid email",
        "Please enter a valid email address, or leave it blank.",
      );
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        name: name.trim(),
        email: trimmedEmail || null,
      })
      .eq("id", profile.id);
    setSaving(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    await refetch();
    Alert.alert("Saved", "Your profile has been updated.");
  }

  function confirmDeleteAccount() {
    Alert.alert(
      "Delete Account",
      "This will permanently delete your account. You can sign up again with the same number but it will be a completely fresh start. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: handleDeleteAccount },
      ],
    );
  }

  async function handleDeleteAccount() {
    if (!profile) return;
    setDeleting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("No session");

      const response = await supabase.functions.invoke("delete-account", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) throw new Error(response.error.message);

      await signOut();
      onDeleteAccount();
    } catch (err: any) {
      console.error("Delete account error:", err);
      Alert.alert(
        "Error",
        err.message ?? "Failed to delete account. Please contact support.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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

        {/* Info */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>PERSONAL INFO</Text>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Full name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor="#4B5563"
              returnKeyType="done"
            />
          </View>
          <View style={styles.fieldDivider} />
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Phone number</Text>
            <Text style={styles.fieldValue}>{profile?.phone ?? "—"}</Text>
            <Text style={styles.fieldNote}>Contact support to change</Text>
          </View>
        </View>

        {/* Email / Receipts */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>RECEIPTS</Text>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Email address</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor="#4B5563"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            <Text style={styles.fieldNote}>
              Get an emailed receipt after each completed ride. Optional — leave
              blank to skip.
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveBtn, saving && { opacity: 0.7 }]}
          onPress={saveProfile}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save changes</Text>
          )}
        </TouchableOpacity>

        {/* Danger zone */}
        <View style={styles.dangerCard}>
          <Text style={styles.dangerLabel}>DANGER ZONE</Text>
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={confirmDeleteAccount}
            disabled={deleting}
            activeOpacity={0.85}
          >
            {deleting ? (
              <ActivityIndicator color="#F87171" />
            ) : (
              <>
                <Ionicons name="trash-outline" size={18} color="#F87171" />
                <Text style={styles.deleteBtnText}>Delete account</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={styles.dangerNote}>
            Permanently removes your account. Your ride history is kept for
            records but detached from your number.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
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
  card: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 20,
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    letterSpacing: 0.08,
    marginBottom: 14,
  },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, color: "#6B7280", fontWeight: "500" },
  input: { fontSize: 15, color: "#F1F5F9", paddingVertical: 8 },
  fieldValue: { fontSize: 15, color: "#CBD5E1", paddingVertical: 8 },
  fieldNote: { fontSize: 12, color: "#4B5563", marginTop: 2 },
  fieldDivider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.07)",
    marginVertical: 8,
  },
  saveBtn: {
    backgroundColor: "#E8500A",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 28,
  },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  dangerCard: {
    backgroundColor: "rgba(248,113,113,0.05)",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.2)",
    padding: 20,
  },
  dangerLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#F87171",
    letterSpacing: 0.08,
    marginBottom: 14,
    opacity: 0.8,
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.25)",
    marginBottom: 10,
  },
  deleteBtnText: { fontSize: 15, fontWeight: "600", color: "#F87171" },
  dangerNote: { fontSize: 12, color: "#6B7280", lineHeight: 16 },
});
