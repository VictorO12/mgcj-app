import React, { useState, useEffect, useRef } from "react";
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
import RideRequestSheet from "./RideRequestSheet";
import ProfileMenu from "../../components/ProfileMenu";
import RideHistoryScreen from "../shared/RideHistoryScreen";
import { useDriverRating } from "../../hooks/useDriverRating";
import DriverEditProfileScreen from "./DriverEditProfileScreen";
import HelpSupportScreen from "../shared/HelpSupportScreen";

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
}

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

interface Props {
  assignedRide: AssignedRide | null;
  onOpenAssigned: () => void;
  confirmedScheduledRides: ConfirmedScheduledRide[];
  onRideAccepted: () => void;
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
}: Props) {
  const { profile, signOut } = useAuth();
  const { average, count } = useDriverRating(profile?.id);
  useNotifications();
  const mapRef = useRef<MapView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const badgePulse = useRef(new Animated.Value(1)).current;

  const [isOnline, setIsOnline] = useState(false);
  const [location, setLocation] = useState<LatLng | null>(null);
  const [pendingRide, setPendingRide] = useState<PendingRide | null>(null);
  const [togglingOnline, setTogglingOnline] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const CARD_WIDTH = Dimensions.get("window").width - 32;
  const [activeCard, setActiveCard] = useState(0);
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);
  const lastDeclinedRideId = useRef<string | null>(null);

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

  useEffect(() => {
    if (locationInterval.current) clearInterval(locationInterval.current);
    if (!isOnline || !profile) return;
    locationInterval.current = setInterval(async () => {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      setLocation(coords);
      await supabase
        .from("drivers")
        .update({
          current_lat: coords.latitude,
          current_lng: coords.longitude,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile.id);
    }, 10000);
    return () => {
      if (locationInterval.current) clearInterval(locationInterval.current);
    };
  }, [isOnline, profile]);

  useEffect(() => {
    if (!isOnline || !profile) return;
    const channel = supabase
      .channel("pending-rides-" + profile.id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides" },
        async (payload) => {
          const row = payload.new as any;
          if (row.status !== "pending") {
            setPendingRide((prev) => (prev?.id === row.id ? null : prev));
            return;
          }
          if (row.id === lastDeclinedRideId.current) return;
          await fetchPendingRide(row.id);
        },
      )
      .subscribe();
    checkExistingPendingRides();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [isOnline, profile]);

  async function checkExistingPendingRides() {
    if (!profile) return;
    const { data } = await supabase
      .from("rides")
      .select("id, declined_by")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);

    if (!data) return;
    const next = data.find(
      (r) =>
        r.id !== lastDeclinedRideId.current &&
        (!r.declined_by || !r.declined_by.includes(profile.id)),
    );
    if (next) await fetchPendingRide(next.id);
  }

  async function fetchPendingRide(rideId: string) {
    if (!profile) return;
    const { data: ride } = await supabase
      .from("rides")
      .select("*")
      .eq("id", rideId)
      .eq("status", "pending")
      .single();
    if (!ride) return;
    if (ride.declined_by && ride.declined_by.includes(profile.id)) return;

    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, phone")
      .eq("id", ride.passenger_id)
      .maybeSingle();

    setPendingRide({
      id: ride.id,
      pickup_address: ride.pickup_address,
      dropoff_address: ride.dropoff_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_phone: passenger?.phone ?? null,
    });
  }

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
      if (!goingOnline) setPendingRide(null);
    }
    setTogglingOnline(false);
  }

  async function acceptRide() {
    if (!pendingRide || !profile) return;
    const { data, error } = await supabase
      .from("rides")
      .update({
        driver_id: profile.id,
        status: "assigned",
        confirmed_by_driver: true,
      })
      .eq("id", pendingRide.id)
      .eq("status", "pending")
      .select("id")
      .single();
    if (error || !data) {
      Alert.alert("Ride unavailable", "This ride was already taken.");
      setPendingRide(null);
      return;
    }
    setPendingRide(null);
    onRideAccepted();
  }

  // timedOut=true: driver ignored the request (30s elapsed), re-show after 30s pause
  // timedOut=false: driver manually declined, write to declined_by, re-show after 1s
  async function declineRide(timedOut: boolean) {
    if (pendingRide && profile?.id) {
      lastDeclinedRideId.current = pendingRide.id;

      if (!timedOut) {
        const { error } = await supabase.rpc("append_declined_by", {
          p_ride_id: pendingRide.id,
          p_driver_id: profile.id,
        });
        if (error) console.error("[declineRide] rpc error:", error);
      }
    }

    setPendingRide(null);

    if (timedOut) {
      setTimeout(() => {
        lastDeclinedRideId.current = null;
        checkExistingPendingRides();
      }, 30000);
    } else {
      setTimeout(() => {
        lastDeclinedRideId.current = null;
        checkExistingPendingRides();
      }, 1000);
    }
  }

  const hasAssignedRide = !!assignedRide;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={VALLEY_REGION}
        showsUserLocation
        showsMyLocationButton={false}
        customMapStyle={darkMapStyle}
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
                { backgroundColor: isOnline ? "#1D9E75" : "#4B5563" },
                isOnline && { transform: [{ scale: pulseAnim }] },
              ]}
            />
            <Text style={styles.statusText}>
              {isOnline ? "Online — accepting rides" : "Offline"}
            </Text>
          </View>
          {average != null && (
            <View style={styles.ratingPill}>
              <Ionicons name="star" size={12} color="#F59E0B" />
              <Text style={styles.ratingText}>{average.toFixed(1)}/5</Text>
              <Text style={styles.ratingCount}>({count})</Text>
            </View>
          )}
        </View>
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

      {/* Assigned ride banner */}
      {hasAssignedRide && (
        <TouchableOpacity
          style={styles.assignedBanner}
          onPress={onOpenAssigned}
          activeOpacity={0.85}
        >
          <View style={styles.assignedBannerDot} />
          <View style={{ flex: 1 }}>
            <Text style={styles.assignedBannerTitle}>
              Ride assignment pending
            </Text>
            <Text style={styles.assignedBannerSub} numberOfLines={1}>
              {assignedRide!.pickup_address} → {assignedRide!.dropoff_address}
            </Text>
          </View>
          <View style={styles.assignedBannerBtn}>
            <Text style={styles.assignedBannerBtnText}>View</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Recenter */}
      {location && (
        <TouchableOpacity
          style={styles.recenterBtn}
          onPress={() =>
            mapRef.current?.animateToRegion(
              { ...location, latitudeDelta: 0.08, longitudeDelta: 0.08 },
              600,
            )
          }
        >
          <Ionicons name="locate" size={20} color="#F1F5F9" />
        </TouchableOpacity>
      )}

      {/* Scheduled panel */}
      {confirmedScheduledRides.length > 0 && (
        <View style={styles.scheduledPanel}>
          <View style={styles.scheduledPanelHeader}>
            <Ionicons name="calendar" size={14} color="#A855F7" />
            <Text style={styles.scheduledPanelTitle}>UPCOMING SCHEDULED</Text>
            <View style={styles.scheduledPanelBadge}>
              <Text style={styles.scheduledPanelBadgeText}>
                {confirmedScheduledRides.length}
              </Text>
            </View>
          </View>
          <FlatList
            data={confirmedScheduledRides}
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
              <View style={[styles.scheduledRideRow, { width: CARD_WIDTH }]}>
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
                  <Text style={styles.scheduledRidePassenger} numberOfLines={1}>
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
          {confirmedScheduledRides.length > 1 && (
            <View style={styles.dotsRow}>
              {confirmedScheduledRides.map((_, i) => (
                <View
                  key={i}
                  style={[styles.dot, i === activeCard && styles.dotActive]}
                />
              ))}
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
                <Ionicons name="radio-outline" size={22} color="#1D9E75" />
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

      {pendingRide && isOnline && (
        <RideRequestSheet
          ride={pendingRide}
          onAccept={acceptRide}
          onDecline={declineRide}
        />
      )}

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
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
    backgroundColor: "rgba(17,24,39,0.88)",
  },
  topName: { fontSize: 20, fontWeight: "700", color: "#F1F5F9", flex: 1 },
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
  ratingText: { fontSize: 13, fontWeight: "600", color: "#F59E0B" },
  ratingCount: { fontSize: 12, color: "#6B7280" },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: "#6B7280" },
  avatarWrap: { position: "relative", padding: 4 },
  topAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  topAvatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  topAvatarInitials: { fontSize: 13, fontWeight: "700", color: "#93C5FD" },
  badge: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#E24B4A",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#111827",
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
    backgroundColor: "#F59E0B",
    flexShrink: 0,
  },
  assignedBannerTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F59E0B",
    marginBottom: 2,
  },
  assignedBannerSub: { fontSize: 11, color: "#6B7280" },
  assignedBannerBtn: {
    backgroundColor: "#F59E0B",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  assignedBannerBtnText: { fontSize: 12, fontWeight: "600", color: "#111827" },
  recenterBtn: {
    position: "absolute",
    right: 16,
    bottom: 220,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#1E2A3A",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  myMarker: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 5,
    borderWidth: 1.5,
    borderColor: "#1D9E75",
  },
  bottomSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#111827",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 44 : 24,
  },
  onlineSheet: { gap: 16 },
  waitingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#1E2A3A",
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
  waitingTitle: { fontSize: 14, fontWeight: "600", color: "#F1F5F9" },
  waitingSubtitle: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  offlineBtn: {
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  offlineBtnText: { color: "#9CA3AF", fontSize: 15, fontWeight: "500" },
  offlineSheet: { alignItems: "center", paddingVertical: 10 },
  offlineTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 8,
  },
  offlineSubtitle: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
    paddingHorizontal: 10,
  },
  onlineBtn: {
    backgroundColor: "#1D9E75",
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 48,
    alignItems: "center",
  },
  onlineBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  scheduledPanel: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 210 : 190,
    left: 16,
    right: 16,
    backgroundColor: "#1A1F2E",
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
  dotActive: { width: 14, backgroundColor: "#A855F7" },
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
    color: "#A855F7",
    letterSpacing: 0.5,
    flex: 1,
  },
  scheduledPanelBadge: {
    backgroundColor: "#A855F7",
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  scheduledPanelBadgeText: { fontSize: 11, fontWeight: "700", color: "#fff" },
  scheduledRideRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.04)",
  },
  scheduledRideTime: {
    backgroundColor: "rgba(168,85,247,0.12)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  scheduledRideTimeText: { fontSize: 11, fontWeight: "600", color: "#C084FC" },
  scheduledRideInfo: { flex: 1 },
  scheduledRidePassenger: { fontSize: 13, fontWeight: "600", color: "#F1F5F9" },
  scheduledRideRoute: { fontSize: 11, color: "#6B7280", marginTop: 1 },
  scheduledRideFare: { fontSize: 13, fontWeight: "600", color: "#1D9E75" },
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
