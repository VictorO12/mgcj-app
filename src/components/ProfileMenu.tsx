import React, { useRef, useEffect, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
  TouchableWithoutFeedback,
  Modal,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Profile } from "../types";
import { useTheme, type ThemeMode } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

interface Props {
  profile: Profile | null;
  visible: boolean;
  onClose: () => void;
  onSignOut: () => void;
  onOpenHistory: () => void;
  onOpenEditProfile?: () => void;
  onOpenHelp?: () => void;
  onOpenProfile?: () => void;
  onOpenNotifications?: () => void;
  onOpenPaymentMethods?: () => void;
  hasAssignedRide?: boolean;
  onOpenAssigned?: () => void;
}

export default function ProfileMenu({
  profile,
  visible,
  onClose,
  onSignOut,
  onOpenHistory,
  onOpenEditProfile,
  onOpenHelp,
  onOpenProfile,
  onOpenNotifications,
  onOpenPaymentMethods,
  hasAssignedRide,
  onOpenAssigned,
}: Props) {
  const { themeMode, setThemeMode, colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const slideY = useRef(new Animated.Value(600)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const themeOptions: { mode: ThemeMode; icon: string; label: string }[] = [
    { mode: "system", icon: "phone-portrait-outline", label: "System" },
    { mode: "light", icon: "sunny-outline", label: "Light" },
    { mode: "dark", icon: "moon-outline", label: "Dark" },
  ];

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideY, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 12,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, {
          toValue: 600,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const initials = profile?.name
    ? profile.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  const avatarUrl = profile?.avatar_url ?? null;
  const isDriver = profile?.role === "driver";

  // Driver: Edit profile + Ride history + Assigned rides + Help
  // Passenger: Profile + Ride history + Notifications + Payment methods + Help
  const menuItems: {
    icon: string;
    label: string;
    sublabel: string;
    badge?: boolean;
    onPress: () => void;
  }[] = isDriver
    ? [
        {
          icon: "person-outline",
          label: "Edit profile",
          sublabel: "Photo, name, vehicle details",
          onPress: () => {
            onClose();
            onOpenEditProfile?.();
          },
        },
        {
          icon: "time-outline",
          label: "Ride history",
          sublabel: "Past trips and receipts",
          onPress: () => {
            onClose();
            onOpenHistory();
          },
        },
        {
          icon: "car-outline",
          label: "Assigned rides",
          sublabel: hasAssignedRide
            ? "You have pending assignments"
            : "No pending assignments",
          badge: hasAssignedRide ?? false,
          onPress: () => {
            onClose();
            onOpenAssigned?.();
          },
        },
        {
          icon: "help-circle-outline",
          label: "Help & support",
          sublabel: "FAQ, contact dispatch",
          onPress: () => {
            onClose();
            onOpenHelp?.();
          },
        },
      ]
    : [
        {
          icon: "person-outline",
          label: "Profile",
          sublabel: "Photo, name, account",
          onPress: () => {
            onClose();
            onOpenProfile?.();
          },
        },
        {
          icon: "time-outline",
          label: "Ride history",
          sublabel: "Past trips and receipts",
          onPress: () => {
            onClose();
            onOpenHistory();
          },
        },
        {
          icon: "notifications-outline",
          label: "Notifications",
          sublabel: "Ride updates, offers",
          onPress: () => {
            onClose();
            onOpenNotifications?.();
          },
        },
        {
          icon: "card-outline",
          label: "Payment methods",
          sublabel: "Cash, card",
          onPress: () => {
            onClose();
            onOpenPaymentMethods?.();
          },
        },
        {
          icon: "help-circle-outline",
          label: "Help & support",
          sublabel: "FAQ, contact us",
          onPress: () => {
            onClose();
            onOpenHelp?.();
          },
        },
      ];

  const handleEditPress = () => {
    onClose();
    if (isDriver) onOpenEditProfile?.();
    else onOpenProfile?.();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[styles.sheet, { transform: [{ translateY: slideY }] }]}
        >
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          {/* Profile header */}
          <View style={styles.profileHeader}>
            <TouchableOpacity onPress={handleEditPress} activeOpacity={0.85}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{profile?.name ?? "User"}</Text>
              <Text style={styles.profilePhone}>{profile?.phone ?? ""}</Text>
            </View>
            {hasAssignedRide && (
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeText}>Ride pending</Text>
              </View>
            )}
            <TouchableOpacity style={styles.editBtn} onPress={handleEditPress}>
              <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          {/* Menu items */}
          <View style={styles.menuList}>
            {menuItems.map((item, i) => (
              <TouchableOpacity
                key={i}
                style={styles.menuItem}
                onPress={item.onPress}
                activeOpacity={0.7}
              >
                <View
                  style={[
                    styles.menuIconWrap,
                    item.badge ? styles.menuIconBadged : null,
                  ]}
                >
                  <Ionicons
                    name={item.icon as any}
                    size={20}
                    color={item.badge ? colors.accentAmber : colors.textTertiary}
                  />
                </View>
                <View style={styles.menuText}>
                  <Text
                    style={[
                      styles.menuLabel,
                      item.badge ? styles.menuLabelBadged : null,
                    ]}
                  >
                    {item.label}
                  </Text>
                  <Text style={styles.menuSublabel}>{item.sublabel}</Text>
                </View>
                {item.badge ? <View style={styles.menuBadgeDot} /> : null}
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.divider} />

          {/* Theme */}
          <View style={styles.themeRow}>
            <Text style={styles.themeLabel}>Theme</Text>
            <View style={styles.themeSegment}>
              {themeOptions.map((opt) => {
                const active = themeMode === opt.mode;
                return (
                  <TouchableOpacity
                    key={opt.mode}
                    style={[
                      styles.themeOption,
                      active && styles.themeOptionActive,
                    ]}
                    onPress={() => setThemeMode(opt.mode)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={opt.icon as any}
                      size={15}
                      color={active ? colors.accentOrange : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.themeOptionText,
                        active && styles.themeOptionTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.divider} />

          {/* Sign out */}
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => {
              onClose();
              onSignOut();
            }}
            activeOpacity={0.7}
          >
            <View style={[styles.menuIconWrap, styles.signOutIconWrap]}>
              <Ionicons name="log-out-outline" size={20} color={colors.accentRed} />
            </View>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>

          <View style={{ height: Platform.OS === "ios" ? 34 : 16 }} />
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 0.5,
    borderColor: colors.border,
  },
  handleRow: { alignItems: "center", paddingTop: 12, paddingBottom: 4 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
  },
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 14,
  },
  avatarImage: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: colors.accentOrange,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.accentOrange,
  },
  avatarText: { fontSize: 18, fontWeight: "700", color: colors.avatarText },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 17, fontWeight: "600", color: colors.textPrimary },
  profilePhone: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  headerBadge: {
    backgroundColor: "rgba(245,158,11,0.15)",
    borderRadius: 12,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderWidth: 0.5,
    borderColor: "rgba(245,158,11,0.3)",
  },
  headerBadgeText: { fontSize: 11, color: colors.accentAmber, fontWeight: "600" },
  editBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 0.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    height: 0.5,
    backgroundColor: colors.border,
    marginHorizontal: 20,
  },
  menuList: { paddingVertical: 6 },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 14,
  },
  menuIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 0.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  menuIconBadged: {
    backgroundColor: "rgba(245,158,11,0.1)",
    borderColor: "rgba(245,158,11,0.25)",
  },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 14, fontWeight: "500", color: colors.textPrimary },
  menuLabelBadged: { color: colors.accentAmber },
  menuSublabel: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  menuBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accentAmber,
  },
  themeRow: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 10,
  },
  themeLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: "600" },
  themeSegment: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 3,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  themeOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 8,
  },
  themeOptionActive: {
    backgroundColor: "rgba(232,80,10,0.12)",
  },
  themeOptionText: { fontSize: 12, fontWeight: "500", color: colors.textSecondary },
  themeOptionTextActive: { color: colors.accentOrange, fontWeight: "600" },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 14,
  },
  signOutIconWrap: {
    backgroundColor: "rgba(248,113,113,0.1)",
    borderColor: "rgba(248,113,113,0.2)",
  },
  signOutText: { fontSize: 14, fontWeight: "500", color: colors.accentRed },
});
