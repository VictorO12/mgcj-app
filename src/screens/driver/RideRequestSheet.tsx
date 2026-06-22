import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
  Vibration,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

const TIMEOUT_SECONDS = 30;

interface PendingRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  passenger_name: string | null;
  passenger_phone: string | null;
  scheduled_at: string | null;
}

interface Props {
  ride: PendingRide;
  onAccept: () => void;
  onDecline: (timedOut: boolean) => void;
}

export default function RideRequestSheet({ ride, onAccept, onDecline }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const slideY = useRef(new Animated.Value(600)).current;
  const timerProgress = useRef(new Animated.Value(1)).current;
  const [secondsLeft, setSecondsLeft] = useState(TIMEOUT_SECONDS);
  const timerInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Always call the latest version of onDecline — avoids stale closure
  // when the timer fires 30s after mount
  const onDeclineRef = useRef(onDecline);
  useEffect(() => {
    onDeclineRef.current = onDecline;
  }, [onDecline]);

  const isScheduled = !!ride.scheduled_at;

  useEffect(() => {
    Animated.spring(slideY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();

    if (Platform.OS === "android") {
      Vibration.vibrate([0, 400, 200, 400]);
    } else {
      Vibration.vibrate();
    }

    Animated.timing(timerProgress, {
      toValue: 0,
      duration: TIMEOUT_SECONDS * 1000,
      useNativeDriver: false,
    }).start();

    timerInterval.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerInterval.current!);
          timerInterval.current = null;
          // Use ref so we always call the latest onDecline, not the one
          // captured at mount time which may have a stale closure
          setTimeout(() => onDeclineRef.current(true), 0);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => {
      if (timerInterval.current) clearInterval(timerInterval.current);
      Vibration.cancel();
    };
  }, []);

  const timerColor = timerProgress.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [colors.accentRedDeep, colors.accentAmber, colors.accentGreen],
  });

  function estimateKm(lat1: number, lng1: number, lat2: number, lng2: number) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const tripKm = estimateKm(
    ride.pickup_lat,
    ride.pickup_lng,
    ride.dropoff_lat,
    ride.dropoff_lng,
  ).toFixed(1);

  function handleDecline() {
    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }
    Vibration.cancel();
    onDeclineRef.current(false);
  }

  function formatScheduledTime(iso: string) {
    return new Date(iso).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return (
    <Animated.View
      style={[styles.sheet, { transform: [{ translateY: slideY }] }]}
    >
      {/* Timer bar */}
      <View style={styles.timerTrack}>
        <Animated.View
          style={[
            styles.timerBar,
            {
              width: timerProgress.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
              backgroundColor: isScheduled ? colors.accentPurple : timerColor,
            },
          ]}
        />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <View
          style={[
            styles.newRideBadge,
            isScheduled && styles.newRideBadgeScheduled,
          ]}
        >
          {isScheduled && (
            <Ionicons
              name="calendar"
              size={12}
              color={colors.accentPurple}
              style={{ marginRight: 4 }}
            />
          )}
          <Text
            style={[
              styles.newRideText,
              isScheduled && styles.newRideTextScheduled,
            ]}
          >
            {isScheduled ? "Scheduled ride" : "New ride request"}
          </Text>
        </View>
        <View style={styles.timerPill}>
          <Ionicons name="time-outline" size={13} color={colors.accentAmber} />
          <Text style={styles.timerText}>{secondsLeft}s</Text>
        </View>
      </View>

      {/* Scheduled time card */}
      {isScheduled && (
        <View style={styles.scheduledCard}>
          <View style={styles.scheduledCardLeft}>
            <Ionicons name="calendar-outline" size={18} color={colors.accentPurple} />
            <View>
              <Text style={styles.scheduledCardLabel}>Scheduled for</Text>
              <Text style={styles.scheduledCardTime}>
                {formatScheduledTime(ride.scheduled_at!)}
              </Text>
            </View>
          </View>
          <View style={styles.scheduledCardBadge}>
            <Text style={styles.scheduledCardBadgeText}>Advance booking</Text>
          </View>
        </View>
      )}

      {/* Passenger */}
      <View style={styles.passengerRow}>
        <View
          style={[
            styles.passengerAvatar,
            isScheduled && styles.passengerAvatarScheduled,
          ]}
        >
          <Text style={styles.passengerInitials}>
            {ride.passenger_name
              ?.split(" ")
              .map((n) => n[0])
              .join("")
              .slice(0, 2)
              .toUpperCase() ?? "?"}
          </Text>
        </View>
        <View>
          <Text style={styles.passengerName}>
            {ride.passenger_name ?? "Passenger"}
          </Text>
          <Text style={styles.passengerSub}>
            {isScheduled ? "Scheduled pickup" : "Requesting a ride"}
          </Text>
        </View>
      </View>

      {/* Route */}
      <View style={styles.routeCard}>
        <View style={styles.routeRow}>
          <View style={[styles.routeDot, { backgroundColor: colors.accentBlue }]} />
          <Text style={styles.routeText} numberOfLines={1}>
            {ride.pickup_address}
          </Text>
        </View>
        <View style={styles.routeLineWrap}>
          <View style={styles.routeLine} />
        </View>
        <View style={styles.routeRow}>
          <View
            style={[
              styles.routeDot,
              { backgroundColor: colors.accentOrange, borderRadius: 3 },
            ]}
          />
          <Text style={styles.routeText} numberOfLines={1}>
            {ride.dropoff_address}
          </Text>
        </View>
      </View>

      {/* Trip stats */}
      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Ionicons name="navigate-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.statValue}>{tripKm} km</Text>
          <Text style={styles.statLabel}>Trip distance</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Ionicons name="cash-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.statValue}>
            ${ride.fare_estimate?.toFixed(2) ?? "--"}
          </Text>
          <Text style={styles.statLabel}>Est. fare</Text>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.declineBtn}
          onPress={handleDecline}
          activeOpacity={0.8}
        >
          <Ionicons name="close" size={22} color={colors.accentRed} />
          <Text style={styles.declineBtnText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.acceptBtn, isScheduled && styles.acceptBtnScheduled]}
          onPress={onAccept}
          activeOpacity={0.85}
        >
          <Ionicons name="checkmark" size={22} color="#fff" />
          <Text style={styles.acceptBtnText}>
            {isScheduled ? "Confirm booking" : "Accept"}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: Platform.OS === "ios" ? 34 : 16 }} />
    </Animated.View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheet: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderTopWidth: 0.5,
      borderColor: colors.border,
      overflow: "hidden",
    },
    timerTrack: { height: 3, backgroundColor: colors.borderSubtle },
    timerBar: { height: 3 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
    },
    newRideBadge: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "rgba(232,80,10,0.15)",
      borderRadius: 20,
      paddingVertical: 4,
      paddingHorizontal: 12,
      borderWidth: 0.5,
      borderColor: "rgba(232,80,10,0.3)",
    },
    newRideBadgeScheduled: {
      backgroundColor: "rgba(168,85,247,0.15)",
      borderColor: "rgba(168,85,247,0.3)",
    },
    newRideText: { fontSize: 12, fontWeight: "600", color: colors.accentOrange },
    newRideTextScheduled: { color: colors.accentPurple },
    timerPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(245,158,11,0.1)",
      borderRadius: 20,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderWidth: 0.5,
      borderColor: "rgba(245,158,11,0.25)",
    },
    timerText: { fontSize: 12, fontWeight: "600", color: colors.accentAmber },
    scheduledCard: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginHorizontal: 20,
      marginBottom: 14,
      backgroundColor: "rgba(168,85,247,0.08)",
      borderRadius: 12,
      padding: 12,
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.25)",
    },
    scheduledCardLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
    scheduledCardLabel: {
      fontSize: 10,
      fontWeight: "600",
      color: colors.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      marginBottom: 2,
    },
    scheduledCardTime: {
      fontSize: 14,
      fontWeight: "700",
      color: colors.accentPurpleTextStrong,
    },
    scheduledCardBadge: {
      backgroundColor: "rgba(168,85,247,0.2)",
      borderRadius: 8,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.35)",
    },
    scheduledCardBadgeText: {
      fontSize: 10,
      fontWeight: "600",
      color: colors.accentPurpleTextSubtle,
    },
    passengerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      marginBottom: 14,
    },
    passengerAvatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: "rgba(74,158,255,0.3)",
    },
    passengerAvatarScheduled: {
      backgroundColor: colors.surfacePurpleTint,
      borderColor: "rgba(168,85,247,0.35)",
    },
    passengerInitials: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.avatarText,
    },
    passengerName: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
    passengerSub: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
    routeCard: {
      marginHorizontal: 20,
      marginBottom: 12,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    routeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    routeDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    routeText: { fontSize: 13, color: colors.textOnSurfaceLight, flex: 1 },
    routeLineWrap: { paddingLeft: 4, paddingVertical: 3 },
    routeLine: {
      width: 1.5,
      height: 14,
      backgroundColor: colors.borderStrong,
      marginLeft: 3,
    },
    statsRow: {
      flexDirection: "row",
      marginHorizontal: 20,
      marginBottom: 16,
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
      overflow: "hidden",
    },
    statBox: { flex: 1, alignItems: "center", paddingVertical: 12, gap: 3 },
    statDivider: { width: 0.5, backgroundColor: colors.border },
    statValue: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
    statLabel: { fontSize: 11, color: colors.textSecondary },
    actions: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 20,
      marginBottom: 4,
    },
    declineBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: "rgba(248,113,113,0.1)",
      borderWidth: 0.5,
      borderColor: "rgba(248,113,113,0.25)",
    },
    declineBtnText: {
      color: colors.accentRed,
      fontSize: 15,
      fontWeight: "600",
    },
    acceptBtn: {
      flex: 2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: colors.accentGreen,
    },
    acceptBtnScheduled: { backgroundColor: colors.accentPurpleDeep },
    acceptBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  });
