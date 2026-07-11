import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  Animated,
  FlatList,
  Dimensions,
  Image,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useNotifications } from "../../hooks/useNotifications";
import ProfileMenu from "../../components/ProfileMenu";
import RideHistoryScreen from "../shared/RideHistoryScreen";
import { useDriverRating } from "../../hooks/useDriverRating";
import DriverEditProfileScreen from "./DriverEditProfileScreen";
import HelpSupportScreen from "../shared/HelpSupportScreen";
import InboxScreen from "../shared/InboxScreen";
import DriverChatScreen from "./DriverChatScreen";
import { useInboxUnreadCount } from "../../hooks/useInboxUnreadCount";
import { useDriverChatUnread } from "../../hooks/useDriverChatUnread";
import { useInterstitialQueue } from "../../hooks/useInterstitialQueue";
import InterstitialMessageCard from "../../components/InterstitialMessageCard";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface AssignedRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  scheduled_at: string | null;
  passenger_name: string | null;
  passenger_phone: string | null;
}

interface LatLng {
  latitude: number;
  longitude: number;
}

interface ConfirmedScheduledRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  scheduled_at: string;
  passenger_name: string | null;
}

interface ActiveScheduledRide {
  id: string;
  scheduled_at: string;
  leave_by: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_address: string;
  dropoff_address: string;
  passenger_name: string | null;
  fare_estimate: number | null;
  payment_method: string | null;
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
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

function calcLeaveInMins(
  location: LatLng | null,
  ride: ActiveScheduledRide,
): number | null {
  if (!location || ride.pickup_lat == null || ride.pickup_lng == null)
    return null;
  const distKm = haversineKm(
    location.latitude,
    location.longitude,
    ride.pickup_lat,
    ride.pickup_lng,
  );
  const driveMins = (distKm / 35) * 60; // 35 km/h conservative for Annapolis Valley
  const minsUntilPickup =
    (new Date(ride.scheduled_at).getTime() - Date.now()) / 60_000;
  return Math.round(minsUntilPickup - driveMins - 3); // 3 min arrival buffer
}

interface Props {
  assignedRide: AssignedRide | null;
  onOpenAssigned: () => void;
  confirmedScheduledRides: ConfirmedScheduledRide[];
  onRideAccepted: () => void;
  openInboxSignal?: number;
  openChatSignal?: number;
  activeScheduledRide?: ActiveScheduledRide | null;
  onStartRide?: () => void;
}

const VALLEY_REGION = {
  latitude: 45.0773,
  longitude: -64.3601,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};

export default function DriverHomeScreen({
  assignedRide,
  onOpenAssigned,
  confirmedScheduledRides,
  onRideAccepted,
  openInboxSignal,
  openChatSignal,
  activeScheduledRide,
  onStartRide,
}: Props) {
  const { profile, signOut } = useAuth();
  const { colors, resolvedTheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { average, count } = useDriverRating(profile?.id);
  useNotifications();
  const mapRef = useRef<MapView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;

  const [isOnline, setIsOnline] = useState(false);
  const [location, setLocation] = useState<LatLng | null>(null);
  const [togglingOnline, setTogglingOnline] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const CARD_WIDTH = Dimensions.get("window").width - 32;
  const [activeCard, setActiveCard] = useState(0);
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);
  const [inboxVisible, setInboxVisible] = useState(false);
  const [chatVisible, setChatVisible] = useState(false);
  const { unreadCount: inboxUnreadCount, refetch: refetchInboxUnread } =
    useInboxUnreadCount();
  const { hasUnread: hasChatUnread, refetch: refetchChatUnread } =
    useDriverChatUnread();

  const [leaveInMins, setLeaveInMins] = useState<number | null>(null);
  const [floatingStackHeight, setFloatingStackHeight] = useState(0);
  const leaveCalcRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (leaveCalcRef.current) clearInterval(leaveCalcRef.current);
    if (!activeScheduledRide) {
      setLeaveInMins(null);
      return;
    }
    const update = () =>
      setLeaveInMins(calcLeaveInMins(location, activeScheduledRide));
    update();
    leaveCalcRef.current = setInterval(update, 30_000);
    return () => {
      if (leaveCalcRef.current) clearInterval(leaveCalcRef.current);
    };
  }, [activeScheduledRide?.id, location]);

  // Opened via a tapped push notification (see DriverApp's notification listener) —
  // signals are counters, not booleans, so a repeat tap re-fires even if already open.
  useEffect(() => {
    if (openInboxSignal) setInboxVisible(true);
  }, [openInboxSignal]);
  useEffect(() => {
    if (openChatSignal) setChatVisible(true);
  }, [openChatSignal]);

  useEffect(() => {
    if (!isOnline) return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    ).start();
    return () => pulseAnim.stopAnimation();
  }, [isOnline]);

  useEffect(() => {
    if (!assignedRide) return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(badgePulse, {
          toValue: 1.3,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(badgePulse, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ).start();
    return () => badgePulse.stopAnimation();
  }, [assignedRide]);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location required",
          "Please enable location to go online.",
        );
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      setLocation(coords);
      mapRef.current?.animateToRegion(
        { ...coords, latitudeDelta: 0.08, longitudeDelta: 0.08 },
        800,
      );
    })();
  }, []);

  useEffect(() => {
    if (!profile) return;
    supabase
      .from("drivers")
      .select("is_active")
      .eq("id", profile.id)
      .single()
      .then(({ data }) => {
        if (data) setIsOnline(data.is_active);
      });
  }, [profile]);

  // Location is broadcast to the `drivers` table by useDriverLocationBroadcast
  // in DriverApp, which keeps running regardless of which driver screen is
  // mounted (this screen unmounts during assigned/active-ride flows).

  async function toggleOnline() {
    if (!profile) return;
    if (!location && !isOnline) {
      Alert.alert(
        "Location unavailable",
        "Please enable location to go online.",
      );
      return;
    }
    setTogglingOnline(true);
    const goingOnline = !isOnline;
    const update: any = { is_active: goingOnline };
    if (goingOnline && location) {
      update.current_lat = location.latitude;
      update.current_lng = location.longitude;
    } else if (!goingOnline) {
      update.current_lat = null;
      update.current_lng = null;
    }
    const { error } = await supabase
      .from("drivers")
      .update(update)
      .eq("id", profile.id);
    if (error) {
      Alert.alert("Error", error.message);
    } else {
      setIsOnline(goingOnline);
    }
    setTogglingOnline(false);
  }

  const hasAssignedRide = !!assignedRide;
  // The active-scheduled ride gets its own countdown card, so drop it from
  // the swipeable carousel instead of hiding the whole carousel behind it.
  const otherScheduledRides = activeScheduledRide
    ? confirmedScheduledRides.filter((r) => r.id !== activeScheduledRide.id)
    : confirmedScheduledRides;
  const showFloatingStack =
    (isOnline && otherScheduledRides.length > 0) || !!activeScheduledRide;
  // DriverApp unmounts this whole screen while on an active/assigned ride
  // (single conditional-return router, not an overlay stack), so the only
  // "not idle" states left to check are pending assignment + local overlays.
  const interstitialGateOpen =
    !hasAssignedRide &&
    !menuVisible &&
    !historyVisible &&
    !editProfileVisible &&
    !helpVisible &&
    !inboxVisible &&
    !chatVisible;
  const { current: interstitialMessage, dismiss: dismissInterstitial } =
    useInterstitialQueue(interstitialGateOpen);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={VALLEY_REGION}
        showsUserLocation
        showsMyLocationButton={false}
        customMapStyle={resolvedTheme === "dark" ? darkMapStyle : []}
      >
        {location && isOnline && (
          <Marker coordinate={location} anchor={{ x: 0.5, y: 0.5 }} title="You">
            <View style={styles.myMarker}>
              <Text style={{ fontSize: 18 }}>🚗</Text>
            </View>
          </Marker>
        )}
      </MapView>

      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topName}>
            {profile?.name?.split(" ")[0] ?? "Driver"}
          </Text>
          <View style={styles.statusRow}>
            <Animated.View
              style={[
                styles.statusDot,
                {
                  backgroundColor: isOnline
                    ? colors.accentGreen
                    : colors.textMuted,
                },
                isOnline && { transform: [{ scale: pulseAnim }] },
              ]}
            />
            <Text style={styles.statusText}>
              {isOnline ? "Online — accepting rides" : "Offline"}
            </Text>
          </View>
          {average != null && (
            <View style={styles.ratingPill}>
              <Ionicons name="star" size={12} color={colors.accentAmber} />
              <Text style={styles.ratingText}>{average.toFixed(1)}/5</Text>
              <Text style={styles.ratingCount}>({count})</Text>
            </View>
          )}
        </View>
        <View style={styles.topActions}>
          <TouchableOpacity
            style={styles.inboxBtn}
            onPress={() => setInboxVisible(true)}
          >
            <Ionicons name="mail-outline" size={18} color={colors.accentBlue} />
            {inboxUnreadCount > 0 && (
              <View style={styles.inboxBadge}>
                <Text style={styles.inboxBadgeText}>
                  {inboxUnreadCount > 9 ? "9+" : inboxUnreadCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.chatBtn}
            onPress={() => setChatVisible(true)}
          >
            <Ionicons
              name="chatbubble-outline"
              size={17}
              color={colors.accentPurple}
            />
            {hasChatUnread && <View style={styles.chatDot} />}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.avatarWrap}
            onPress={() => setMenuVisible(true)}
          >
            {profile?.avatar_url ? (
              <Image
                source={{ uri: profile.avatar_url }}
                style={styles.topAvatar}
              />
            ) : (
              <View style={styles.topAvatarFallback}>
                <Text style={styles.topAvatarInitials}>
                  {profile?.name
                    ? profile.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .slice(0, 2)
                        .toUpperCase()
                    : "?"}
                </Text>
              </View>
            )}
            {hasAssignedRide && (
              <Animated.View
                style={[styles.badge, { transform: [{ scale: badgePulse }] }]}
              >
                <Text style={styles.badgeText}>1</Text>
              </Animated.View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Assigned ride banner — dispatch-assigned rides only */}
      {hasAssignedRide && (
        <TouchableOpacity
          style={[
            styles.assignedBanner,
            assignedRide!.scheduled_at && styles.assignedBannerScheduled,
          ]}
          onPress={onOpenAssigned}
          activeOpacity={0.85}
        >
          <View
            style={[
              styles.assignedBannerDot,
              assignedRide!.scheduled_at && {
                backgroundColor: colors.accentPurple,
              },
            ]}
          />
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.assignedBannerTitle,
                assignedRide!.scheduled_at && { color: colors.accentPurple },
              ]}
            >
              {assignedRide!.scheduled_at
                ? "Scheduled ride pending confirmation"
                : "Ride assignment pending"}
            </Text>
            {assignedRide!.scheduled_at ? (
              <>
                <Text style={styles.assignedBannerScheduledTime}>
                  {new Date(assignedRide!.scheduled_at).toLocaleString(
                    "en-CA",
                    {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    },
                  )}
                </Text>
                <Text style={styles.assignedBannerSub} numberOfLines={1}>
                  {assignedRide!.pickup_address} →{" "}
                  {assignedRide!.dropoff_address}
                </Text>
              </>
            ) : (
              <Text style={styles.assignedBannerSub} numberOfLines={1}>
                {assignedRide!.pickup_address} → {assignedRide!.dropoff_address}
              </Text>
            )}
          </View>
          <View
            style={[
              styles.assignedBannerBtn,
              assignedRide!.scheduled_at && {
                backgroundColor: colors.accentPurple,
              },
            ]}
          >
            <Text style={styles.assignedBannerBtnText}>View</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Recenter */}
      {location && (
        <TouchableOpacity
          style={[
            styles.recenterBtn,
            !isOnline && { bottom: styles.recenterBtn.bottom + 40 },
            showFloatingStack && {
              bottom:
                (Platform.OS === "ios" ? 220 : 200) +
                floatingStackHeight +
                10,
            },
          ]}
          onPress={() =>
            mapRef.current?.animateToRegion(
              { ...location, latitudeDelta: 0.08, longitudeDelta: 0.08 },
              600,
            )
          }
        >
          <Ionicons name="locate" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      )}

      {/* Floating stack: upcoming-scheduled carousel + active countdown card,
          stacked above the bottom sheet instead of the countdown card
          replacing (and hiding) the carousel entirely. */}
      {showFloatingStack && (
        <View
          style={styles.floatingStack}
          onLayout={(e) => setFloatingStackHeight(e.nativeEvent.layout.height)}
        >
          {activeScheduledRide &&
            (() => {
              const isLate = leaveInMins !== null && leaveInMins < 0;
              const accentColor = isLate
                ? colors.accentRedDeep
                : colors.accentGreen;
              const pickupTime = new Date(
                activeScheduledRide.scheduled_at,
              ).toLocaleTimeString("en-CA", {
                hour: "numeric",
                minute: "2-digit",
              });
              const label = activeScheduledRide.passenger_name
                ? `${pickupTime} · ${activeScheduledRide.passenger_name}`
                : pickupTime;
              const statusText =
                leaveInMins === null
                  ? null
                  : leaveInMins > 1
                    ? `Leave in ${leaveInMins} min`
                    : leaveInMins >= 0
                      ? "Leave now"
                      : `${Math.abs(leaveInMins)} min late`;

              return (
                <View
                  style={[
                    styles.countdownCard,
                    { borderColor: accentColor + "40" },
                  ]}
                >
                  <View
                    style={[
                      styles.countdownCardIcon,
                      { backgroundColor: accentColor + "1F" },
                    ]}
                  >
                    <Ionicons
                      name={isLate ? "alert" : "navigate"}
                      size={18}
                      color={accentColor}
                    />
                  </View>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={styles.countdownCardLabel} numberOfLines={1}>
                      {label}
                    </Text>
                    <Text style={styles.countdownCardRoute} numberOfLines={1}>
                      {activeScheduledRide.pickup_address} →{" "}
                      {activeScheduledRide.dropoff_address}
                    </Text>
                    {statusText && (
                      <Text
                        style={[
                          styles.countdownCardStatus,
                          { color: accentColor },
                        ]}
                      >
                        {statusText}
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.countdownCardBtn,
                      { backgroundColor: accentColor },
                    ]}
                    onPress={onStartRide}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="navigate" size={13} color="#fff" />
                    <Text style={styles.countdownCardBtnText}>On My Way</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}

          {isOnline && otherScheduledRides.length > 0 && (
            <View style={styles.scheduledPanel}>
              <View style={styles.scheduledPanelHeader}>
                <Ionicons
                  name="calendar"
                  size={14}
                  color={colors.accentPurple}
                />
                <Text style={styles.scheduledPanelTitle}>
                  UPCOMING SCHEDULED
                </Text>
                <View style={styles.scheduledPanelBadge}>
                  <Text style={styles.scheduledPanelBadgeText}>
                    {otherScheduledRides.length}
                  </Text>
                </View>
              </View>
              <FlatList
                data={otherScheduledRides}
                keyExtractor={(r) => r.id}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onScroll={(e) => {
                  const index = Math.round(
                    e.nativeEvent.contentOffset.x / CARD_WIDTH,
                  );
                  setActiveCard(index);
                }}
                scrollEventThrottle={16}
                renderItem={({ item: r }) => (
                  <View
                    style={[styles.scheduledRideRow, { width: CARD_WIDTH }]}
                  >
                    <View style={styles.scheduledRideTime}>
                      <Text style={styles.scheduledRideTimeText}>
                        {new Date(r.scheduled_at).toLocaleString("en-CA", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Text>
                    </View>
                    <View style={styles.scheduledRideInfo}>
                      <Text
                        style={styles.scheduledRidePassenger}
                        numberOfLines={1}
                      >
                        {r.passenger_name ?? "Passenger"}
                      </Text>
                      <Text style={styles.scheduledRideRoute} numberOfLines={1}>
                        {r.pickup_address} → {r.dropoff_address}
                      </Text>
                    </View>
                    {r.fare_estimate && (
                      <Text style={styles.scheduledRideFare}>
                        ${r.fare_estimate.toFixed(2)}
                      </Text>
                    )}
                  </View>
                )}
              />
              {otherScheduledRides.length > 1 && (
                <View style={styles.dotsRow}>
                  {otherScheduledRides.map((_, i) => (
                    <View
                      key={i}
                      style={[styles.dot, i === activeCard && styles.dotActive]}
                    />
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {/* Bottom sheet */}
      <View style={styles.bottomSheet}>
        {isOnline ? (
          <View style={styles.onlineSheet}>
            <View style={styles.waitingRow}>
              <View style={styles.waitingIcon}>
                <Ionicons
                  name="radio-outline"
                  size={22}
                  color={colors.accentGreen}
                />
              </View>
              <View>
                <Text style={styles.waitingTitle}>
                  Waiting for a ride request
                </Text>
                <Text style={styles.waitingSubtitle}>
                  You'll be notified when a passenger books
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.offlineBtn}
              onPress={toggleOnline}
              disabled={togglingOnline}
              activeOpacity={0.8}
            >
              <Text style={styles.offlineBtnText}>Go offline</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.offlineSheet}>
            <Text style={styles.offlineTitle}>You're offline</Text>
            <Text style={styles.offlineSubtitle}>
              Go online to start receiving ride requests in the Annapolis
              Valley.
            </Text>
            <TouchableOpacity
              style={[styles.onlineBtn, togglingOnline && { opacity: 0.6 }]}
              onPress={toggleOnline}
              disabled={togglingOnline}
              activeOpacity={0.85}
            >
              <Text style={styles.onlineBtnText}>
                {togglingOnline ? "Connecting…" : "Go online"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {historyVisible && (
        <View style={StyleSheet.absoluteFill}>
          <RideHistoryScreen onClose={() => setHistoryVisible(false)} />
        </View>
      )}
      {editProfileVisible && (
        <View style={StyleSheet.absoluteFill}>
          <DriverEditProfileScreen
            onClose={() => setEditProfileVisible(false)}
          />
        </View>
      )}
      {helpVisible && (
        <View style={StyleSheet.absoluteFill}>
          <HelpSupportScreen onClose={() => setHelpVisible(false)} />
        </View>
      )}
      {inboxVisible && (
        <View style={StyleSheet.absoluteFill}>
          <InboxScreen
            onClose={() => {
              setInboxVisible(false);
              refetchInboxUnread();
            }}
          />
        </View>
      )}
      {chatVisible && (
        <View style={StyleSheet.absoluteFill}>
          <DriverChatScreen
            onClose={() => {
              setChatVisible(false);
              refetchChatUnread();
            }}
          />
        </View>
      )}
      {interstitialMessage && (
        <InterstitialMessageCard
          message={interstitialMessage}
          onDismiss={() => {
            dismissInterstitial();
            refetchInboxUnread();
          }}
        />
      )}

      <ProfileMenu
        profile={profile}
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        onSignOut={signOut}
        onOpenHistory={() => setHistoryVisible(true)}
        onOpenEditProfile={() => setEditProfileVisible(true)}
        onOpenHelp={() => setHelpVisible(true)}
        hasAssignedRide={hasAssignedRide}
        onOpenAssigned={() => {
          setMenuVisible(false);
          onOpenAssigned();
        }}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    map: { flex: 1 },
    topBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingHorizontal: 20,
      paddingBottom: 12,
      backgroundColor: colors.backgroundOverlay,
    },
    topName: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.textPrimary,
      flex: 1,
    },
    statusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 3,
    },
    ratingPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 4,
      alignSelf: "flex-start",
    },
    ratingText: { fontSize: 13, fontWeight: "600", color: colors.accentAmber },
    ratingCount: { fontSize: 12, color: colors.textSecondary },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusText: { fontSize: 12, color: colors.textSecondary },
    topActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    inboxBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: "rgba(74,158,255,0.12)",
      borderWidth: 0.5,
      borderColor: "rgba(74,158,255,0.3)",
      alignItems: "center",
      justifyContent: "center",
    },
    inboxBadge: {
      position: "absolute",
      top: -4,
      right: -4,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      paddingHorizontal: 3,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.background,
    },
    inboxBadgeText: { fontSize: 9, fontWeight: "700", color: "#fff" },
    chatBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: "rgba(168,85,247,0.12)",
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.3)",
      alignItems: "center",
      justifyContent: "center",
    },
    chatDot: {
      position: "absolute",
      top: 4,
      right: 4,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.accentOrange,
      borderWidth: 1.5,
      borderColor: colors.background,
    },
    avatarWrap: { position: "relative", padding: 4 },
    topAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1.5,
      borderColor: colors.accentOrange,
    },
    topAvatarFallback: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.accentOrange,
    },
    topAvatarInitials: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.avatarText,
    },
    badge: {
      position: "absolute",
      top: 0,
      right: 0,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: colors.accentRedDeep,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.background,
    },
    badgeText: { fontSize: 10, fontWeight: "700", color: "#fff" },
    assignedBanner: {
      position: "absolute",
      top: Platform.OS === "ios" ? 110 : 96,
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: "rgba(245,158,11,0.12)",
      borderRadius: 14,
      padding: 12,
      borderWidth: 0.5,
      borderColor: "rgba(245,158,11,0.35)",
    },
    assignedBannerDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.accentAmber,
      flexShrink: 0,
    },
    assignedBannerTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.accentAmber,
      marginBottom: 2,
    },
    assignedBannerSub: { fontSize: 11, color: colors.textSecondary },
    assignedBannerBtn: {
      backgroundColor: colors.accentAmber,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    assignedBannerBtnText: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.background,
    },
    assignedBannerScheduled: {
      backgroundColor: "rgba(168,85,247,0.12)",
      borderColor: "rgba(168,85,247,0.35)",
    },
    assignedBannerScheduledTime: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.accentPurple,
      marginBottom: 1,
    },
    recenterBtn: {
      position: "absolute",
      right: 16,
      bottom: 220,
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    myMarker: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      padding: 5,
      borderWidth: 1.5,
      borderColor: colors.accentGreen,
    },
    bottomSheet: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderTopWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: Platform.OS === "ios" ? 44 : 24,
    },
    onlineSheet: { gap: 16 },
    waitingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.25)",
    },
    waitingIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: "rgba(29,158,117,0.1)",
      alignItems: "center",
      justifyContent: "center",
    },
    waitingTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    waitingSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    offlineBtn: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: "center",
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    offlineBtnText: {
      color: colors.textTertiary,
      fontSize: 15,
      fontWeight: "500",
    },
    offlineSheet: { alignItems: "center", paddingVertical: 10 },
    offlineTitle: {
      fontSize: 22,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 8,
    },
    offlineSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 20,
      marginBottom: 24,
      paddingHorizontal: 10,
    },
    onlineBtn: {
      backgroundColor: colors.accentGreen,
      borderRadius: 14,
      paddingVertical: 15,
      paddingHorizontal: 48,
      alignItems: "center",
    },
    onlineBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
    floatingStack: {
      position: "absolute",
      bottom: Platform.OS === "ios" ? 220 : 200,
      left: 16,
      right: 16,
      gap: 10,
    },
    countdownCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      padding: 12,
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 8,
      elevation: 8,
    },
    countdownCardIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 10,
      flexShrink: 0,
    },
    countdownCardLabel: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.textPrimary,
    },
    countdownCardRoute: {
      fontSize: 11,
      color: colors.textSecondary,
      marginTop: 2,
    },
    countdownCardStatus: {
      fontSize: 11,
      fontWeight: "600",
      marginTop: 3,
    },
    countdownCardBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderRadius: 18,
      paddingVertical: 9,
      paddingHorizontal: 14,
      flexShrink: 0,
    },
    countdownCardBtnText: {
      color: "#fff",
      fontSize: 13,
      fontWeight: "700",
    },
    scheduledPanel: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.25)",
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
    },
    dotsRow: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 5,
      paddingVertical: 8,
    },
    dot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: "rgba(168,85,247,0.25)",
    },
    dotActive: { width: 14, backgroundColor: colors.accentPurple },
    scheduledPanelHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 0.5,
      borderBottomColor: "rgba(168,85,247,0.15)",
    },
    scheduledPanelTitle: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.accentPurple,
      letterSpacing: 0.5,
      flex: 1,
    },
    scheduledPanelBadge: {
      backgroundColor: colors.accentPurple,
      borderRadius: 10,
      minWidth: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 5,
    },
    scheduledPanelBadgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: "#fff",
    },
    scheduledRideRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.borderSubtle,
    },
    scheduledRideTime: {
      backgroundColor: "rgba(168,85,247,0.12)",
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    scheduledRideTimeText: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.accentPurpleTextSubtle,
    },
    scheduledRideInfo: { flex: 1 },
    scheduledRidePassenger: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    scheduledRideRoute: {
      fontSize: 11,
      color: colors.textSecondary,
      marginTop: 1,
    },
    scheduledRideFare: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.accentGreen,
    },
  });

const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#1d2c3f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8ec3b9" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a3646" }] },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#253d56" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#2c6675" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#0e1626" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
