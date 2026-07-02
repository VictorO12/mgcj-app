import React, { useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Modal,
  Platform,
  Animated,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";
import type { InterstitialMessage } from "../hooks/useInterstitialQueue";

interface Props {
  message: InterstitialMessage;
  onDismiss: () => void;
}

const CATEGORY_ICON: Record<string, string> = {
  announcement: "megaphone-outline",
  offer: "pricetag-outline",
};
const CATEGORY_LABEL: Record<string, string> = {
  announcement: "Announcement",
  offer: "Limited-time offer",
};

const SCREEN_HEIGHT = Dimensions.get("window").height;

export default function InterstitialMessageCard({ message, onDismiss }: Props) {
  const { colors } = useTheme();
  const isOffer = message.category === "offer";
  const accentColor = isOffer ? colors.accentOrange : colors.accentBlue;
  const cardTint = isOffer ? colors.surfaceOrangeTint : colors.surfaceAlt;
  const styles = useMemo(() => makeStyles(colors, cardTint), [colors, cardTint]);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 22,
      stiffness: 220,
    }).start();
  }, [translateY]);

  return (
    <Modal visible transparent animationType="none" onRequestClose={onDismiss}>
      <View style={styles.wrap} pointerEvents="box-none">
        <Animated.View style={[styles.card, { transform: [{ translateY }] }]}>
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>
          <TouchableOpacity style={styles.close} onPress={onDismiss}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          {message.image_url && (
            <Image source={{ uri: message.image_url }} style={styles.image} />
          )}
          <View style={styles.body}>
            <View style={styles.eyebrowRow}>
              <Ionicons name={CATEGORY_ICON[message.category] as any} size={13} color={accentColor} />
              <Text style={[styles.eyebrow, { color: accentColor }]}>
                {CATEGORY_LABEL[message.category]}
              </Text>
            </View>
            <Text style={styles.title}>{message.title}</Text>
            <Text style={styles.text}>{message.body}</Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors, cardTint: string) =>
  StyleSheet.create({
    wrap: {
      flex: 1,
      justifyContent: "flex-end",
    },
    card: {
      width: "100%",
      minHeight: 260,
      backgroundColor: cardTint,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderBottomWidth: 0,
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.5,
          shadowRadius: 28,
          shadowOffset: { width: 0, height: -10 },
        },
        android: { elevation: 20 },
      }),
    },
    handleRow: { alignItems: "center", paddingTop: 10, paddingBottom: 2 },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.borderStrong,
    },
    close: {
      position: "absolute",
      top: 14,
      right: 14,
      zIndex: 1,
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.backgroundOverlay,
      alignItems: "center",
      justifyContent: "center",
    },
    image: { width: "100%", height: 180, marginTop: 6 },
    body: {
      flex: 1,
      paddingHorizontal: 22,
      paddingTop: 10,
      paddingBottom: Platform.OS === "ios" ? 24 : 30,
    },
    eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
    eyebrow: { fontSize: 12, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
    title: { fontSize: 19, fontWeight: "700", color: colors.textPrimary, marginBottom: 8, lineHeight: 24 },
    text: { fontSize: 14, color: colors.textOnSurfaceLight, lineHeight: 21 },
  });
