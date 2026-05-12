import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import Constants from "expo-constants";

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey;

// ── Polyline decoder ────────────────────────────────────────────────────────
function decodePolyline(
  encoded: string,
): { latitude: number; longitude: number }[] {
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0,
    lat = 0,
    lng = 0;
  while (index < encoded.length) {
    let b,
      shift = 0,
      result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

// ── Haversine distance (metres) ─────────────────────────────────────────────
function getDistance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function turnIcon(maneuver: string): string {
  if (!maneuver) return "navigate-outline";
  if (maneuver.includes("left")) return "arrow-back-outline";
  if (maneuver.includes("right")) return "arrow-forward-outline";
  if (maneuver.includes("uturn")) return "return-down-back-outline";
  if (maneuver.includes("roundabout")) return "refresh-outline";
  if (maneuver.includes("straight")) return "arrow-up-outline";
  return "navigate-outline";
}

// ── Compute target directly from ride props — never stale ──────────────────
function getTarget(ride: ActiveRide): { latitude: number; longitude: number } {
  const isPickingUp =
    ride.status === "assigned" || ride.status === "driver_arriving";
  return isPickingUp
    ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
    : { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng };
}

interface DirectionStep {
  html_instructions: string;
  distance: { text: string; value: number };
  duration: { text: string; value: number };
  maneuver?: string;
  end_location: { lat: number; lng: number };
}

interface ActiveRide {
  id: string;
  status: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  passenger_name: string | null;
  passenger_phone: string | null;
}

interface LatLng {
  latitude: number;
  longitude: number;
}

interface Props {
  ride: ActiveRide;
  onRideComplete: () => void;
  onStatusChange?: (newStatus: string) => void;
}

export default function DriverActiveRideScreen({
  ride,
  onRideComplete,
  onStatusChange,
}: Props) {
  const { profile } = useAuth();
  const mapRef = useRef<MapView>(null);

  const [location, setLocation] = useState<LatLng | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [updating, setUpdating] = useState(false);
  const [routeCoords, setRouteCoords] = useState<LatLng[]>([]);
  const [steps, setSteps] = useState<DirectionStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [navMode, setNavMode] = useState(false);

  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const etaInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRef = useRef<LatLng | null>(null);

  // Derive target directly — no ref needed, always computed fresh from ride prop
  const isPickingUp =
    ride.status === "assigned" || ride.status === "driver_arriving";
  const target = getTarget(ride);

  const statusLabel = () => {
    switch (ride.status) {
      case "assigned":
        return "Head to pickup";
      case "driver_arriving":
        return "Arriving at pickup";
      case "in_progress":
        return "Dropping off passenger";
      default:
        return "Active ride";
    }
  };

  const nextActionLabel = () => {
    switch (ride.status) {
      case "assigned":
        return "I've arrived at pickup";
      case "driver_arriving":
        return "Start ride";
      case "in_progress":
        return "Complete ride";
      default:
        return "Next";
    }
  };

  const nextStatus = () => {
    switch (ride.status) {
      case "assigned":
        return "driver_arriving";
      case "driver_arriving":
        return "in_progress";
      case "in_progress":
        return "completed";
      default:
        return null;
    }
  };

  // ── Mount: get GPS, route to pickup, start location tracking ───────────────
  useEffect(() => {
    const pickup: LatLng = {
      latitude: ride.pickup_lat,
      longitude: ride.pickup_lng,
    };

    (async () => {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      locationRef.current = coords;
      setLocation(coords);
      // Always route to pickup on mount — screen opens when status = "assigned"
      fetchRoute(coords, pickup);
      fitMap(coords, pickup);
      // Start 30s refresh interval pinned to pickup
      if (etaInterval.current) clearInterval(etaInterval.current);
      etaInterval.current = setInterval(() => {
        const l = locationRef.current;
        if (l) fetchRoute(l, pickup);
      }, 30000);
    })();

    locationInterval.current = setInterval(async () => {
      if (!profile) return;
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      locationRef.current = coords;
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
      if (etaInterval.current) clearInterval(etaInterval.current);
    };
  }, []);

  // ── Route to a new target — called directly, never waits for prop change ──
  function switchRouteTo(newTarget: LatLng) {
    setCurrentStepIndex(0);
    // Do NOT clear routeCoords here — keep old line visible until new one loads
    if (etaInterval.current) clearInterval(etaInterval.current);
    const loc = locationRef.current;
    if (loc) {
      fetchRoute(loc, newTarget);
      fitMap(loc, newTarget);
    }
    etaInterval.current = setInterval(() => {
      const l = locationRef.current;
      if (l) fetchRoute(l, newTarget);
    }, 30000);
  }

  // ── Advance turn step when driver nears end of current step ─────────────
  useEffect(() => {
    if (!location || steps.length === 0) return;
    for (let i = currentStepIndex; i < steps.length; i++) {
      const stepEnd = steps[i].end_location;
      const dist = getDistance(location, {
        latitude: stepEnd.lat,
        longitude: stepEnd.lng,
      });
      if (dist < 40) {
        setCurrentStepIndex(Math.min(i + 1, steps.length - 1));
        break;
      }
    }
  }, [location]);

  function fitMap(driverCoords: LatLng, toCoords: LatLng) {
    mapRef.current?.fitToCoordinates([driverCoords, toCoords], {
      edgePadding: {
        top: navMode ? 160 : 80,
        right: 60,
        bottom: 320,
        left: 60,
      },
      animated: true,
    });
  }

  async function fetchRoute(from: LatLng, to: LatLng) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${from.latitude},${from.longitude}` +
        `&destination=${to.latitude},${to.longitude}` +
        `&key=${MAPS_KEY}` +
        `&alternatives=false`;

      const res = await fetch(url);
      const json = await res.json();

      console.log("[DriverRoute] status:", json.status);
      console.log("[DriverRoute] routes:", json.routes?.length);
      if (json.status !== "OK") {
        console.warn(
          "[DriverRoute] API error:",
          json.status,
          json.error_message,
        );
        return;
      }

      const route = json.routes?.[0];
      if (!route) return;

      const leg = route.legs?.[0];
      const seconds = leg?.duration?.value;
      setEta(seconds ? Math.ceil(seconds / 60) : null);

      const encoded = route.overview_polyline?.points;
      console.log("[DriverRoute] polyline length:", encoded?.length);
      if (encoded) setRouteCoords(decodePolyline(encoded));

      setSteps(leg?.steps ?? []);
    } catch (e) {
      console.error("[DriverRoute] exception:", e);
    }
  }

  async function advanceStatus() {
    const next = nextStatus();
    if (!next) return;
    setUpdating(true);

    if (next === "completed") {
      Alert.alert(
        "Complete ride?",
        `Confirm the trip to ${ride.dropoff_address} is complete.`,
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => setUpdating(false),
          },
          {
            text: "Complete",
            onPress: async () => {
              await supabase
                .from("rides")
                .update({ status: "completed", fare_final: ride.fare_estimate })
                .eq("id", ride.id);
              setUpdating(false);
              onRideComplete();
            },
          },
        ],
      );
      return;
    }

    await supabase.from("rides").update({ status: next }).eq("id", ride.id);

    // Switch the route immediately — don't wait for parent re-render
    if (next === "driver_arriving" || next === "in_progress") {
      // Passenger not yet in car but driver at pickup, or ride started → dropoff
      switchRouteTo({
        latitude: ride.dropoff_lat,
        longitude: ride.dropoff_lng,
      });
    }

    // Notify parent to update its local state (drives status label etc.)
    onStatusChange?.(next);
    setUpdating(false);
  }

  function callPassenger() {
    if (!ride.passenger_phone) return;
    Linking.openURL(`tel:${ride.passenger_phone}`);
  }

  function smsPassenger() {
    if (!ride.passenger_phone) return;
    Linking.openURL(`sms:${ride.passenger_phone}`);
  }

  const currentStep = steps[currentStepIndex];
  const nextStep = steps[currentStepIndex + 1];

  return (
    <View style={styles.container}>
      {/* ── MAP ── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        customMapStyle={darkMapStyle}
        showsUserLocation
        showsMyLocationButton={false}
        showsTraffic={navMode}
      >
        {location && (
          <Marker coordinate={location} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.driverMarker}>
              <Text style={{ fontSize: 18 }}>🚗</Text>
            </View>
          </Marker>
        )}
        <Marker
          coordinate={{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }}
          pinColor="#4a9eff"
          title="Pickup"
        />
        <Marker
          coordinate={{
            latitude: ride.dropoff_lat,
            longitude: ride.dropoff_lng,
          }}
          pinColor="#E8500A"
          title="Drop-off"
        />
        {location && (
          <Polyline
            coordinates={
              routeCoords.length > 1 ? routeCoords : [location, target]
            }
            strokeColor={isPickingUp ? "#4a9eff" : "#E8500A"}
            strokeWidth={routeCoords.length > 1 ? 4 : 2.5}
            lineDashPattern={routeCoords.length > 1 ? undefined : [6, 4]}
          />
        )}
      </MapView>

      {/* ── NAV BANNER ── */}
      {navMode && currentStep && (
        <View style={styles.navBanner}>
          <View style={styles.navMain}>
            <View style={styles.navIconWrap}>
              <Ionicons
                name={turnIcon(currentStep.maneuver ?? "") as any}
                size={26}
                color="#fff"
              />
            </View>
            <View style={styles.navTextWrap}>
              <Text style={styles.navInstruction} numberOfLines={2}>
                {stripHtml(currentStep.html_instructions)}
              </Text>
              <Text style={styles.navDistance}>
                {currentStep.distance?.text}
              </Text>
            </View>
            <View style={styles.etaPill}>
              <Text style={styles.etaPillText}>
                {eta !== null ? `${eta}m` : "--"}
              </Text>
            </View>
          </View>
          {nextStep && (
            <View style={styles.navNext}>
              <Text style={styles.navNextLabel}>Then: </Text>
              <Text style={styles.navNextText} numberOfLines={1}>
                {stripHtml(nextStep.html_instructions)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── TOP STATUS BAR ── */}
      {!navMode && (
        <View style={styles.topBar}>
          <View style={styles.statusBadge}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isPickingUp ? "#4a9eff" : "#E8500A" },
              ]}
            />
            <Text style={styles.statusLabel}>{statusLabel()}</Text>
          </View>
          {eta !== null && (
            <View style={styles.etaBadge}>
              <Text style={styles.etaText}>{eta} min</Text>
            </View>
          )}
        </View>
      )}

      {/* ── NAV TOGGLE ── */}
      <TouchableOpacity
        style={[styles.navToggleBtn, navMode && styles.navToggleBtnActive]}
        onPress={() => {
          setNavMode((v) => !v);
          if (!navMode && location) fitMap(location, target);
        }}
      >
        <Ionicons
          name={navMode ? "navigate" : "navigate-outline"}
          size={18}
          color="#fff"
        />
        <Text style={styles.navToggleText}>
          {navMode ? "Exit nav" : "Navigate"}
        </Text>
      </TouchableOpacity>

      {/* ── BOTTOM SHEET ── */}
      <View style={styles.sheet}>
        <View style={styles.destinationCard}>
          <View style={styles.destIcon}>
            <Ionicons
              name={isPickingUp ? "location" : "flag"}
              size={18}
              color={isPickingUp ? "#4a9eff" : "#E8500A"}
            />
          </View>
          <View style={styles.destText}>
            <Text style={styles.destLabel}>
              {isPickingUp ? "Pickup location" : "Drop-off location"}
            </Text>
            <Text style={styles.destAddress} numberOfLines={1}>
              {isPickingUp ? ride.pickup_address : ride.dropoff_address}
            </Text>
          </View>
          <Text style={styles.etaLarge}>{eta !== null ? `${eta}m` : "--"}</Text>
        </View>

        <View style={styles.passengerCard}>
          <View style={styles.passengerAvatar}>
            <Text style={styles.passengerInitials}>
              {ride.passenger_name
                ?.split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)
                .toUpperCase() ?? "?"}
            </Text>
          </View>
          <View style={styles.passengerInfo}>
            <Text style={styles.passengerName}>
              {ride.passenger_name ?? "Passenger"}
            </Text>
            <Text style={styles.fareText}>
              Est. fare: ${ride.fare_estimate?.toFixed(2) ?? "--"}
            </Text>
          </View>
          <View style={styles.contactBtns}>
            <TouchableOpacity style={styles.contactBtn} onPress={smsPassenger}>
              <Ionicons name="chatbubble-outline" size={18} color="#CBD5E1" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.contactBtn} onPress={callPassenger}>
              <Ionicons name="call-outline" size={18} color="#CBD5E1" />
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.actionBtn, updating && { opacity: 0.6 }]}
          onPress={advanceStatus}
          disabled={updating}
          activeOpacity={0.85}
        >
          {updating ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons
                name="checkmark-circle-outline"
                size={20}
                color="#fff"
              />
              <Text style={styles.actionBtnText}>{nextActionLabel()}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  map: { flex: 1 },

  navBanner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0F1E30",
    paddingTop: Platform.OS === "ios" ? 54 : 36,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.07)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
  },
  navMain: { flexDirection: "row", alignItems: "center", gap: 12 },
  navIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#1D9E75",
    alignItems: "center",
    justifyContent: "center",
  },
  navTextWrap: { flex: 1 },
  navInstruction: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F1F5F9",
    lineHeight: 22,
  },
  navDistance: { fontSize: 13, color: "#6B7280", marginTop: 3 },
  etaPill: {
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  etaPillText: { fontSize: 14, fontWeight: "700", color: "#F1F5F9" },
  navNext: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  navNextLabel: { fontSize: 12, color: "#4B5563" },
  navNextText: { fontSize: 12, color: "#9CA3AF", flex: 1 },

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
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 13, fontWeight: "600", color: "#F1F5F9" },
  etaBadge: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  etaText: { fontSize: 13, fontWeight: "700", color: "#F1F5F9" },

  navToggleBtn: {
    position: "absolute",
    right: 16,
    bottom: 310,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#1A2332",
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  navToggleBtnActive: {
    backgroundColor: "#1D9E75",
    borderColor: "rgba(29,158,117,0.5)",
  },
  navToggleText: { fontSize: 13, fontWeight: "500", color: "#fff" },

  driverMarker: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 5,
    borderWidth: 1.5,
    borderColor: "#1D9E75",
  },

  sheet: {
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
    paddingTop: 16,
    paddingBottom: Platform.OS === "ios" ? 44 : 24,
    gap: 12,
  },
  destinationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  destIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  destText: { flex: 1 },
  destLabel: { fontSize: 11, color: "#6B7280" },
  destAddress: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F1F5F9",
    marginTop: 2,
  },
  etaLarge: { fontSize: 22, fontWeight: "700", color: "#F1F5F9" },

  passengerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  passengerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(74,158,255,0.3)",
  },
  passengerInitials: { fontSize: 14, fontWeight: "700", color: "#93C5FD" },
  passengerInfo: { flex: 1 },
  passengerName: { fontSize: 15, fontWeight: "600", color: "#F1F5F9" },
  fareText: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  contactBtns: { flexDirection: "row", gap: 8 },
  contactBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#253D56",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },

  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#E8500A",
    borderRadius: 14,
    paddingVertical: 15,
  },
  actionBtnText: { fontSize: 15, fontWeight: "600", color: "#fff" },
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
