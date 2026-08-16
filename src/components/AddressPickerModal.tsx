import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsRoutingKey;

export interface PickedAddress {
  lat: number;
  lng: number;
  address: string;
}

interface Prediction {
  place_id: string;
  description: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
}

interface Props {
  visible: boolean;
  title: string;
  /** Shown under the title — e.g. what changing this will cost. */
  note?: string;
  initialQuery?: string;
  /** Biases autocomplete toward the passenger, same as the booking search. */
  near?: { latitude: number; longitude: number } | null;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (place: PickedAddress) => void;
}

function stripCountry(description: string): string {
  return description.replace(/,\s*Canada\s*$/i, "");
}

export default function AddressPickerModal({
  visible,
  title,
  note,
  initialQuery = "",
  near,
  confirmLabel = "Confirm",
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [query, setQuery] = useState(initialQuery);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PickedAddress | null>(null);
  const [resolving, setResolving] = useState(false);
  // Autocomplete is billed per keystroke-ish, so debounce rather than firing on
  // every character the way an uncontrolled search would.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setQuery(initialQuery);
    setPredictions([]);
    setPicked(null);
  }, [visible, initialQuery]);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  function onChangeQuery(text: string) {
    setQuery(text);
    setPicked(null);
    if (debounce.current) clearTimeout(debounce.current);
    if (text.trim().length < 3) {
      setPredictions([]);
      return;
    }
    debounce.current = setTimeout(() => searchPlaces(text), 300);
  }

  async function searchPlaces(text: string) {
    setSearching(true);
    try {
      const loc = near
        ? `&location=${near.latitude},${near.longitude}&radius=30000`
        : "";
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
          text,
        )}&key=${MAPS_KEY}&components=country:ca${loc}`,
      );
      setPredictions((await res.json()).predictions ?? []);
    } catch (e) {
      console.error("[AddressPicker] autocomplete", e);
    }
    setSearching(false);
  }

  async function choose(p: Prediction) {
    setResolving(true);
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=geometry&key=${MAPS_KEY}`,
      );
      const loc = (await res.json()).result?.geometry?.location;
      if (!loc) return;
      // Store the full description, not the short display name — the civic
      // number is in it and the driver needs it, same rule as booking.
      setPicked({
        lat: loc.lat,
        lng: loc.lng,
        address: stripCountry(p.description),
      });
      setQuery(
        p.structured_formatting?.main_text || p.description.split(",")[0],
      );
      setPredictions([]);
    } catch (e) {
      console.error("[AddressPicker] details", e);
    }
    setResolving(false);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>{title}</Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}

          <View style={styles.inputRow}>
            <Ionicons name="search" size={18} color={colors.textFaint} />
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={onChangeQuery}
              placeholder="Search for an address"
              placeholderTextColor={colors.textFaint}
              autoFocus
              returnKeyType="search"
            />
            {(searching || resolving) && (
              <ActivityIndicator size="small" color={colors.accentOrange} />
            )}
          </View>

          {predictions.length > 0 && (
            <ScrollView
              style={styles.predictions}
              keyboardShouldPersistTaps="handled"
            >
              {predictions.map((p) => (
                <TouchableOpacity
                  key={p.place_id}
                  style={styles.prediction}
                  onPress={() => choose(p)}
                >
                  <Ionicons
                    name="location-outline"
                    size={18}
                    color={colors.textSecondary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.predMain} numberOfLines={1}>
                      {p.structured_formatting?.main_text ??
                        p.description.split(",")[0]}
                    </Text>
                    <Text style={styles.predSub} numberOfLines={1}>
                      {p.structured_formatting?.secondary_text ??
                        stripCountry(p.description)}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {picked && (
            <View style={styles.pickedRow}>
              <Ionicons
                name="checkmark-circle"
                size={18}
                color={colors.accentGreen}
              />
              <Text style={styles.pickedText} numberOfLines={2}>
                {picked.address}
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost]}
              onPress={onCancel}
              disabled={busy}
            >
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.btn,
                styles.btnPrimary,
                (!picked || busy) && styles.btnDisabled,
              ]}
              onPress={() => picked && onConfirm(picked)}
              disabled={!picked || busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnPrimaryText}>{confirmLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 28,
      maxHeight: "85%",
    },
    grabber: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      alignSelf: "center",
      marginBottom: 14,
    },
    title: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
    note: {
      color: colors.textSecondary,
      fontSize: 13,
      marginTop: 6,
      lineHeight: 18,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.surfaceAlt,
      borderRadius: 12,
      paddingHorizontal: 12,
      height: 48,
      marginTop: 16,
    },
    input: { flex: 1, color: colors.textPrimary, fontSize: 15 },
    predictions: { marginTop: 10, maxHeight: 260 },
    prediction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    predMain: { color: colors.textPrimary, fontSize: 15 },
    predSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    pickedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 14,
    },
    pickedText: { color: colors.textSecondary, fontSize: 13, flex: 1 },
    actions: { flexDirection: "row", gap: 12, marginTop: 20 },
    btn: {
      flex: 1,
      height: 48,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    btnGhost: { backgroundColor: colors.surfaceAlt },
    btnGhostText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
    btnPrimary: { backgroundColor: colors.accentOrange },
    btnPrimaryText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    btnDisabled: { opacity: 0.5 },
  });
}
