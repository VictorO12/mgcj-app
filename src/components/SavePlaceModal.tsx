import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";
import { useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { safeBottom } from "../hooks/useLayout";
import type { PlaceKind } from "../lib/savedPlaces";

interface Props {
  visible: boolean;
  /** The full address being saved — shown so they can see what they're naming. */
  address: string;
  /** Kinds already taken, so Home/Work can be disabled rather than failing. */
  takenKinds: PlaceKind[];
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (kind: PlaceKind, name: string | null) => void;
}

export default function SavePlaceModal({
  visible,
  address,
  takenKinds,
  saving,
  error,
  onCancel,
  onSave,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets), [colors, insets]);
  const [kind, setKind] = useState<PlaceKind>("custom");
  const [name, setName] = useState("");

  // Reset between openings — the modal stays mounted, so without this the
  // previous place's name is pre-filled over the new one.
  useEffect(() => {
    if (visible) {
      setKind("custom");
      setName("");
    }
  }, [visible]);

  const canSave = kind !== "custom" || name.trim().length > 0;

  const KINDS: { kind: PlaceKind; label: string; icon: any }[] = [
    { kind: "home", label: "Home", icon: "home" },
    { kind: "work", label: "Work", icon: "briefcase" },
    { kind: "custom", label: "Other", icon: "star" },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <View style={styles.handleBar} />
              <Text style={styles.title}>Save this place</Text>
              <Text style={styles.subtitle} numberOfLines={2}>
                {address}
              </Text>
            </View>

            <View style={styles.body}>
              <View style={styles.kindRow}>
                {KINDS.map((k) => {
                  const taken = k.kind !== "custom" && takenKinds.includes(k.kind);
                  const selected = kind === k.kind;
                  return (
                    <TouchableOpacity
                      key={k.kind}
                      style={[
                        styles.kindBtn,
                        selected && styles.kindBtnSelected,
                        taken && styles.kindBtnDisabled,
                      ]}
                      disabled={taken}
                      onPress={() => setKind(k.kind)}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name={k.icon}
                        size={18}
                        color={selected ? colors.accentOrange : colors.textSecondary}
                      />
                      <Text
                        style={[
                          styles.kindText,
                          selected && styles.kindTextSelected,
                        ]}
                      >
                        {k.label}
                      </Text>
                      {taken && <Text style={styles.takenText}>saved</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {kind === "custom" && (
                <TextInput
                  style={styles.nameInput}
                  placeholder="Name it — e.g. Mum's, the gym"
                  placeholderTextColor={colors.textMuted}
                  value={name}
                  onChangeText={setName}
                  maxLength={40}
                  autoFocus
                  returnKeyType="done"
                />
              )}

              {!!error && <Text style={styles.errorText}>{error}</Text>}
            </View>

            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, (!canSave || saving) && styles.saveBtnDisabled]}
                disabled={!canSave || saving}
                onPress={() => onSave(kind, kind === "custom" ? name.trim() : null)}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.saveText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (colors: Colors, insets: EdgeInsets) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.modalOverlay,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingBottom: safeBottom(insets, 6, 28),
      borderTopWidth: 0.5,
      borderColor: colors.border,
    },
    header: {
      alignItems: "center",
      paddingTop: 12,
      paddingBottom: 8,
      paddingHorizontal: 24,
    },
    handleBar: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.textFaint,
      marginBottom: 20,
    },
    title: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 6,
    },
    subtitle: { fontSize: 13, color: colors.textSecondary, textAlign: "center" },
    body: { paddingHorizontal: 20, paddingTop: 16 },
    kindRow: { flexDirection: "row", gap: 10 },
    kindBtn: {
      flex: 1,
      alignItems: "center",
      gap: 6,
      paddingVertical: 14,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    kindBtnSelected: {
      borderColor: colors.accentOrange,
      backgroundColor: "rgba(232,80,10,0.08)",
    },
    kindBtnDisabled: { opacity: 0.35 },
    kindText: { fontSize: 13, color: colors.textTertiary },
    kindTextSelected: { color: colors.textPrimary, fontWeight: "600" },
    takenText: { fontSize: 10, color: colors.textMuted },
    nameInput: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      color: colors.textPrimary,
      fontSize: 14,
      padding: 14,
      marginTop: 12,
    },
    errorText: { color: colors.accentRed, fontSize: 13, marginTop: 10 },
    actions: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 16,
    },
    cancelBtn: {
      flex: 1,
      paddingVertical: 15,
      borderRadius: 14,
      alignItems: "center",
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    cancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
    saveBtn: {
      flex: 2,
      paddingVertical: 15,
      borderRadius: 14,
      alignItems: "center",
      backgroundColor: colors.accentOrange,
    },
    saveBtnDisabled: { opacity: 0.4 },
    saveText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  });
