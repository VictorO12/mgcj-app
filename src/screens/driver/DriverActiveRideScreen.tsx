import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Modal,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import Constants from "expo-constants";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsRoutingKey;
const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl;
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey;

// ── Polyline decoder ──────────────────────────────────────────────────────
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
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

// ── Haversine distance in metres ──────────────────────────────────────────
function getDistance(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ── Strip HTML tags from Google instruction strings ───────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ── Manoeuvre → Ionicon name ──────────────────────────────────────────────
function manoeuvreIcon(manoeuvre?: string): string {
  if (!manoeuvre) return "arrow-up";
  if (manoeuvre.includes("left")) return "arrow-back";
  if (manoeuvre.includes("right")) return "arrow-forward";
  if (manoeuvre.includes("uturn")) return "return-up-back";
  if (manoeuvre.includes("merge") || manoeuvre.includes("ramp"))
    return "git-merge";
  if (manoeuvre.includes("roundabout")) return "refresh";
  return "arrow-up";
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
  payment_method?: string | null;
}

interface LatLng {
  latitude: number;
  longitude: number;
}

interface Step {
  html_instructions: string;
  distance: { text: string; value: number };
  duration: { text: string };
  maneuver?: string;
  end_location: { lat: number; lng: number };
}

interface Props {
  ride: ActiveRide;
  onRideComplete: () => void;
  onStatusChange: (newStatus: string) => void;
}

export default function DriverActiveRideScreen({
  ride,
  onRideComplete,
  onStatusChange,
}: Props) {
  const { profile } = useAuth();
  const { colors, resolvedTheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mapRef = useRef<MapView>(null);

  const [location, setLocation] = useState<LatLng | null>(null);
  const locationRef = useRef<LatLng | null>(null);

  const [eta, setEta] = useState<number | null>(null);
  const [routeCoords, setRouteCoords] = useState<LatLng[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [totalDistanceM, setTotalDistanceM] = useState<number | null>(null);

  const [heading, setHeading] = useState(0);
  const headingRef = useRef(0);
  const [navMode, setNavMode] = useState(false);
  const navModeRef = useRef(false);
  const [updating, setUpdating] = useState(false);

  // Fare modal
  const [showFareModal, setShowFareModal] = useState(false);
  const [fareInput, setFareInput] = useState(
    ride.fare_estimate?.toFixed(2) ?? "",
  );
  const [completing, setCompleting] = useState(false);

  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const etaInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const isPickingUp =
    ride.status === "assigned" || ride.status === "driver_arriving";
  const target: LatLng = isPickingUp
    ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
    : { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng };
  const targetRef = useRef<LatLng>(target);

  useEffect(() => {
    navModeRef.current = navMode;
  }, [navMode]);
  useEffect(() => {
    targetRef.current = target;
  }, [ride.status]);

  // ── Labels ────────────────────────────────────────────────────────────
  function statusLabel() {
    switch (ride.status) {
      case "assigned":
        return "Head to pickup";
      case "driver_arriving":
        return "Arrived at pickup";
      case "in_progress":
        return "Dropping off passenger";
      default:
        return "Active ride";
    }
  }

  function nextActionLabel() {
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
  }

  function nextStatus() {
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
  }

  // ── Location tracking ─────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
      locationRef.current = coords;
      setLocation(coords);
      fetchRoute(coords, targetRef.current);
    })();

    locationInterval.current = setInterval(async () => {
      if (!profile) return;
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const coords = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        locationRef.current = coords;
        setLocation(coords);
        if (loc.coords.heading !== null && loc.coords.heading >= 0) {
          headingRef.current = loc.coords.heading;
          setHeading(loc.coords.heading);
        }
        await supabase
          .from("drivers")
          .update({
            current_lat: coords.latitude,
            current_lng: coords.longitude,
          })
          .eq("id", profile.id);
      } catch (e) {
        console.error("[Location]", e);
      }
    }, 8000);

    return () => {
      if (locationInterval.current) clearInterval(locationInterval.current);
      if (etaInterval.current) clearInterval(etaInterval.current);
    };
  }, []);

  // ── Refresh route every 30s ───────────────────────────────────────────
  useEffect(() => {
    if (etaInterval.current) clearInterval(etaInterval.current);
    etaInterval.current = setInterval(() => {
      const loc = locationRef.current;
      if (loc) fetchRoute(loc, targetRef.current);
    }, 30000);
    return () => {
      if (etaInterval.current) clearInterval(etaInterval.current);
    };
  }, []);

  // ── Re-fetch when status changes ─────────────────────────────────────
  useEffect(() => {
    setCurrentStepIndex(0);
    setRouteCoords([]);
    setSteps([]);
    const newTarget =
      ride.status === "assigned" || ride.status === "driver_arriving"
        ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
        : { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng };
    targetRef.current = newTarget;
    const loc = locationRef.current;
    if (loc) fetchRoute(loc, newTarget);
  }, [ride.status]);

  // ── Advance nav step on proximity ────────────────────────────────────
  useEffect(() => {
    if (!location || steps.length === 0) return;
    for (let i = currentStepIndex; i < steps.length; i++) {
      const stepEnd = {
        latitude: steps[i].end_location.lat,
        longitude: steps[i].end_location.lng,
      };
      if (getDistance(location, stepEnd) < 40) {
        setCurrentStepIndex(Math.min(i + 1, steps.length - 1));
        break;
      }
    }
  }, [location]);

  // ── Off-route detection + automatic rerouting ─────────────────────────
  const isRerouting = useRef(false);
  const [showRerouting, setShowRerouting] = useState(false);

  useEffect(() => {
    if (!location || routeCoords.length < 2 || isRerouting.current) return;
    let minDist = Infinity;
    for (const point of routeCoords) {
      const d = getDistance(location, point);
      if (d < minDist) minDist = d;
    }
    if (minDist > 50) {
      console.log(
        `[Reroute] Off route by ${Math.round(minDist)}m — recalculating`,
      );
      isRerouting.current = true;
      setShowRerouting(true);
      setCurrentStepIndex(0);
      fetchRoute(location, targetRef.current).finally(() => {
        isRerouting.current = false;
        setShowRerouting(false);
      });
    }
  }, [location]);

  const lastCameraUpdate = useRef<number>(0);
  const lastHeadingRef = useRef<number>(0);

  useEffect(() => {
    if (!navMode || !location) return;
    const now = Date.now();
    const timeSinceLast = now - lastCameraUpdate.current;
    const headingDelta = Math.abs(headingRef.current - lastHeadingRef.current);
    if (timeSinceLast < 4000 && headingDelta < 10) return;
    lastCameraUpdate.current = now;
    lastHeadingRef.current = headingRef.current;
    mapRef.current?.animateCamera(
      {
        center: location,
        heading: headingRef.current,
        pitch: 60,
        zoom: 18,
        altitude: 200,
      },
      { duration: 1000 },
    );
  }, [location, heading, navMode]);

  // ── Fetch route ───────────────────────────────────────────────────────
  async function fetchRoute(from: LatLng, to: LatLng) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${from.latitude},${from.longitude}` +
        `&destination=${to.latitude},${to.longitude}` +
        `&key=${MAPS_KEY}` +
        `&alternatives=false` +
        `&departure_time=now` +
        `&traffic_model=best_guess`;
      const res = await fetch(url);
      const json = await res.json();
      const route = json.routes?.[0];
      if (!route) return;
      const seconds =
        route.legs?.[0]?.duration_in_traffic?.value ??
        route.legs?.[0]?.duration?.value;
      setEta(seconds ? Math.ceil(seconds / 60) : null);
      setTotalDistanceM(route.legs?.[0]?.distance?.value ?? null);
      const encoded = route.overview_polyline?.points;
      if (encoded) setRouteCoords(decodePolyline(encoded));
      setSteps(route.legs?.[0]?.steps ?? []);
      if (!navModeRef.current && mapRef.current) {
        mapRef.current.fitToCoordinates([from, to], {
          edgePadding: { top: 120, right: 50, bottom: 300, left: 50 },
          animated: true,
        });
      }
    } catch (e) {
      console.error("[fetchRoute]", e);
    }
  }

  // ── Status advance ────────────────────────────────────────────────────
  async function advanceStatus() {
    const next = nextStatus();
    if (!next) return;

    if (next === "completed") {
      if (ride.payment_method === "card") {
        // ── Card ride: capture the payment hold then complete ───
        setUpdating(true);
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) throw new Error("No session");

          const res = await fetch(
            `${SUPABASE_URL}/functions/v1/capture-payment`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.access_token}`,
                apikey: SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({ ride_id: ride.id }),
            },
          );

          const result = await res.json();

          if (!res.ok) {
            setUpdating(false);
            Alert.alert(
              "Payment capture failed",
              result.error ?? "Could not capture payment. Please try again.",
            );
            return;
          }

          // Payment captured — mark ride complete
          await supabase
            .from("rides")
            .update({ status: "completed", fare_final: ride.fare_estimate })
            .eq("id", ride.id);

          setUpdating(false);
          onRideComplete();
        } catch (err) {
          console.error("Capture error:", err);
          setUpdating(false);
          Alert.alert("Error", "Something went wrong. Please try again.");
        }
        return;
      }

      // ── Cash ride: show fare entry modal ───────────────────────
      setFareInput(ride.fare_estimate?.toFixed(2) ?? "");
      setShowFareModal(true);
      return;
    }

    // ── Any other status transition ─────────────────────────────
    setUpdating(true);
    await supabase.from("rides").update({ status: next }).eq("id", ride.id);
    onStatusChange(next);
    setUpdating(false);
  }

  async function handleCompleteRide() {
    const fareValue = parseFloat(fareInput);
    if (isNaN(fareValue) || fareValue <= 0) {
      Alert.alert("Invalid fare", "Please enter a valid fare amount.");
      return;
    }
    setCompleting(true);
    const { error } = await supabase
      .from("rides")
      .update({ status: "completed", fare_final: fareValue })
      .eq("id", ride.id);
    setCompleting(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setShowFareModal(false);
    onRideComplete();
  }

  const currentStep = steps[currentStepIndex];
  const paymentIsCash = !ride.payment_method || ride.payment_method === "cash";

  return (
    <View style={styles.container}>
      {/* ── MAP ── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        customMapStyle={resolvedTheme === "dark" ? darkMapStyle : []}
        showsUserLocation
        showsMyLocationButton={false}
        showsTraffic={navMode}
        showsCompass={navMode}
        pitchEnabled={navMode}
        rotateEnabled={navMode}
        scrollEnabled={!navMode}
        zoomEnabled={!navMode}
      >
        <Marker
          coordinate={{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }}
          anchor={{ x: 0.5, y: 1 }}
        >
          <View style={styles.pickupMarker}>
            <Ionicons name="location" size={20} color={colors.accentBlue} />
          </View>
        </Marker>
        <Marker
          coordinate={{
            latitude: ride.dropoff_lat,
            longitude: ride.dropoff_lng,
          }}
          anchor={{ x: 0.5, y: 1 }}
        >
          <View style={styles.dropoffMarker}>
            <Ionicons name="flag" size={18} color={colors.accentOrange} />
          </View>
        </Marker>
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={isPickingUp ? colors.accentBlue : colors.accentOrange}
            strokeWidth={navMode ? 5 : 3.5}
          />
        )}
      </MapView>

      {/* ── NAV INSTRUCTION BANNER ── */}
      {navMode && showRerouting && (
        <View style={styles.reroutingBanner}>
          <ActivityIndicator size="small" color={colors.accentAmber} />
          <Text style={styles.reroutingText}>Rerouting…</Text>
        </View>
      )}

      {navMode && !showRerouting && currentStep && (
        <View style={styles.navBanner}>
          <View style={styles.navBannerIcon}>
            <Ionicons
              name={manoeuvreIcon(currentStep.maneuver) as any}
              size={28}
              color="#fff"
            />
          </View>
          <View style={styles.navBannerText}>
            <Text style={styles.navInstruction} numberOfLines={2}>
              {stripHtml(currentStep.html_instructions)}
            </Text>
            <Text style={styles.navDistance}>{currentStep.distance.text}</Text>
          </View>
          {eta !== null && (
            <View style={styles.navEtaBox}>
              <Text style={styles.navEtaNum}>{eta}</Text>
              <Text style={styles.navEtaUnit}>min</Text>
            </View>
          )}
        </View>
      )}

      {/* ── TOP STATUS BAR (non-nav mode) ── */}
      {!navMode && (
        <View style={styles.topBar}>
          <View style={styles.statusBadge}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isPickingUp ? colors.accentBlue : colors.accentOrange },
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

      {/* ── NAVIGATE BUTTON ── */}
      <TouchableOpacity
        style={[styles.navBtn, navMode && styles.navBtnActive]}
        onPress={() => {
          const next = !navMode;
          setNavMode(next);
          if (!next && location) {
            mapRef.current?.fitToCoordinates([location, target], {
              edgePadding: { top: 120, right: 50, bottom: 300, left: 50 },
              animated: true,
            });
          }
        }}
      >
        <Ionicons
          name={navMode ? "close" : "navigate"}
          size={20}
          color="#fff"
        />
        <Text style={styles.navBtnText}>
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
              color={isPickingUp ? colors.accentBlue : colors.accentOrange}
            />
          </View>
          <View style={styles.destText}>
            <Text style={styles.destLabel}>
              {isPickingUp ? "Pickup location" : "Drop-off location"}
            </Text>
            <Text style={styles.destAddress} numberOfLines={1}>
              {isPickingUp ? ride.pickup_address : ride.dropoff_address}
            </Text>
            {totalDistanceM !== null && (
              <Text style={styles.destDistance}>
                {totalDistanceM >= 1000
                  ? `${(totalDistanceM / 1000).toFixed(1)} km`
                  : `${totalDistanceM} m`}
              </Text>
            )}
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
            <View style={styles.farePaymentRow}>
              <Text style={styles.fareText}>
                Est. ${ride.fare_estimate?.toFixed(2) ?? "--"}
              </Text>
              <View
                style={[
                  styles.paymentBadge,
                  !paymentIsCash && styles.paymentBadgeCard,
                ]}
              >
                <Ionicons
                  name={paymentIsCash ? "cash-outline" : "card-outline"}
                  size={11}
                  color={paymentIsCash ? colors.accentGreen : colors.accentBlue}
                />
                <Text
                  style={[
                    styles.paymentBadgeText,
                    !paymentIsCash && styles.paymentBadgeTextCard,
                  ]}
                >
                  {paymentIsCash ? "Cash" : "Card"}
                </Text>
              </View>
            </View>
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
              <Text style={styles.actionBtnText}>{nextActionLabel()}</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* ── FARE MODAL (cash only) ── */}
      <Modal
        visible={showFareModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFareModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.fareModal}>
            <View style={styles.modalHandle} />
            <Text style={styles.fareModalTitle}>Complete ride</Text>
            <Text style={styles.fareModalSub}>
              Enter the final cash fare collected
            </Text>

            <View style={styles.fareRouteCard}>
              <View style={styles.fareRouteRow}>
                <View
                  style={[styles.fareRouteDot, { backgroundColor: colors.accentBlue }]}
                />
                <Text style={styles.fareRouteText} numberOfLines={1}>
                  {ride.pickup_address}
                </Text>
              </View>
              <View style={styles.fareRouteLine} />
              <View style={styles.fareRouteRow}>
                <View
                  style={[
                    styles.fareRouteDot,
                    { backgroundColor: colors.accentOrange, borderRadius: 3 },
                  ]}
                />
                <Text style={styles.fareRouteText} numberOfLines={1}>
                  {ride.dropoff_address}
                </Text>
              </View>
            </View>

            <View style={styles.farePassengerRow}>
              <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.farePassengerText}>
                {ride.passenger_name ?? "Passenger"}
              </Text>
              <View
                style={[styles.paymentBadge, { marginLeft: "auto" as any }]}
              >
                <Ionicons name="cash-outline" size={11} color={colors.accentGreen} />
                <Text style={styles.paymentBadgeText}>Cash</Text>
              </View>
            </View>

            <View style={styles.fareInputWrap}>
              <Text style={styles.fareCurrencySymbol}>$</Text>
              <TextInput
                style={styles.fareInput}
                value={fareInput}
                onChangeText={setFareInput}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.textFaint}
                autoFocus
                selectTextOnFocus
              />
            </View>

            {ride.fare_estimate && (
              <TouchableOpacity
                style={styles.estimateHint}
                onPress={() => setFareInput(ride.fare_estimate!.toFixed(2))}
              >
                <Text style={styles.estimateHintText}>
                  Use estimate: ${ride.fare_estimate.toFixed(2)}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.fareModalBtns}>
              <TouchableOpacity
                style={styles.fareModalCancelBtn}
                onPress={() => setShowFareModal(false)}
              >
                <Text style={styles.fareModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.fareModalConfirmBtn,
                  completing && { opacity: 0.6 },
                ]}
                onPress={handleCompleteRide}
                disabled={completing}
              >
                {completing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.fareModalConfirmText}>
                    Collect & Complete
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    map: { flex: 1 },
    reroutingBanner: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      backgroundColor: colors.surface,
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingBottom: 16,
      paddingHorizontal: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    reroutingText: {
      fontSize: 17,
      fontWeight: "700",
      color: colors.accentAmber,
    },
    navBanner: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surface,
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingBottom: 16,
      paddingHorizontal: 16,
      gap: 14,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    navBannerIcon: {
      width: 52,
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    navBannerText: { flex: 1 },
    navInstruction: {
      fontSize: 17,
      fontWeight: "700",
      color: colors.textPrimary,
      lineHeight: 22,
    },
    navDistance: { fontSize: 13, color: colors.textSecondary, marginTop: 3 },
    navEtaBox: {
      alignItems: "center",
      backgroundColor: colors.background,
      borderRadius: 10,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    navEtaNum: { fontSize: 22, fontWeight: "700", color: colors.accentAmber },
    navEtaUnit: { fontSize: 10, color: colors.textSecondary },
    topBar: {
      position: "absolute",
      top: Platform.OS === "ios" ? 56 : 40,
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.backgroundOverlay,
      borderRadius: 20,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusLabel: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
    etaBadge: {
      backgroundColor: colors.backgroundOverlay,
      borderRadius: 16,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    etaText: { fontSize: 13, fontWeight: "700", color: colors.accentAmber },
    navBtn: {
      position: "absolute",
      right: 16,
      bottom: 340,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.accentGreen,
      borderRadius: 20,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    navBtnActive: { backgroundColor: colors.textFaint },
    navBtnText: { fontSize: 14, fontWeight: "600", color: "#fff" },
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
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: Platform.OS === "ios" ? 44 : 24,
      gap: 12,
    },
    destinationCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    destIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    destText: { flex: 1 },
    destLabel: { fontSize: 11, color: colors.textSecondary, marginBottom: 2 },
    destAddress: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
    destDistance: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
    etaLarge: { fontSize: 22, fontWeight: "700", color: colors.accentAmber },
    passengerCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    passengerAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: "rgba(74,158,255,0.3)",
    },
    passengerInitials: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.avatarText,
    },
    passengerInfo: { flex: 1 },
    passengerName: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 4,
    },
    farePaymentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    fareText: { fontSize: 13, color: colors.textTertiary },
    paymentBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(29,158,117,0.12)",
      borderRadius: 8,
      paddingVertical: 2,
      paddingHorizontal: 7,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.25)",
    },
    paymentBadgeCard: {
      backgroundColor: "rgba(74,158,255,0.12)",
      borderColor: "rgba(74,158,255,0.25)",
    },
    paymentBadgeText: {
      fontSize: 10,
      color: colors.accentGreen,
      fontWeight: "600",
    },
    paymentBadgeTextCard: { color: colors.accentBlue },
    actionBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      backgroundColor: colors.accentOrange,
      borderRadius: 14,
      paddingVertical: 16,
    },
    actionBtnText: { fontSize: 16, fontWeight: "600", color: "#fff" },
    pickupMarker: {
      backgroundColor: "rgba(74,158,255,0.15)",
      borderRadius: 20,
      padding: 6,
      borderWidth: 1,
      borderColor: "rgba(74,158,255,0.4)",
    },
    dropoffMarker: {
      backgroundColor: "rgba(232,80,10,0.15)",
      borderRadius: 20,
      padding: 6,
      borderWidth: 1,
      borderColor: "rgba(232,80,10,0.4)",
    },
    modalOverlay: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.modalOverlay,
    },
    fareModal: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderTopWidth: 0.5,
      borderColor: colors.border,
      padding: 24,
      paddingBottom: Platform.OS === "ios" ? 44 : 28,
      gap: 14,
    },
    modalHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.borderStrong,
      alignSelf: "center",
      marginBottom: 6,
    },
    fareModalTitle: {
      fontSize: 22,
      fontWeight: "700",
      color: colors.textPrimary,
      textAlign: "center",
    },
    fareModalSub: {
      fontSize: 13,
      color: colors.textSecondary,
      textAlign: "center",
      marginTop: -6,
    },
    fareRouteCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    fareRouteRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 3,
    },
    fareRouteDot: { width: 9, height: 9, borderRadius: 5, flexShrink: 0 },
    fareRouteText: {
      fontSize: 13,
      color: colors.textOnSurfaceLight,
      flex: 1,
    },
    fareRouteLine: {
      width: 1.5,
      height: 12,
      backgroundColor: colors.borderStrong,
      marginLeft: 3.5,
      marginVertical: 2,
    },
    farePassengerRow: { flexDirection: "row", alignItems: "center", gap: 7 },
    farePassengerText: { fontSize: 13, color: colors.textTertiary },
    fareInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: "rgba(232,80,10,0.35)",
      paddingHorizontal: 20,
      paddingVertical: 14,
      gap: 6,
    },
    fareCurrencySymbol: {
      fontSize: 32,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    fareInput: {
      flex: 1,
      fontSize: 42,
      fontWeight: "700",
      color: colors.textPrimary,
      letterSpacing: 1,
    },
    estimateHint: {
      alignSelf: "center",
      paddingVertical: 6,
      paddingHorizontal: 16,
      borderRadius: 10,
      backgroundColor: "rgba(232,80,10,0.08)",
      borderWidth: 0.5,
      borderColor: "rgba(232,80,10,0.2)",
      marginTop: -4,
    },
    estimateHintText: {
      fontSize: 12,
      color: colors.accentOrange,
      fontWeight: "500",
    },
    fareModalBtns: { flexDirection: "row", gap: 12, marginTop: 4 },
    fareModalCancelBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: colors.surface,
      alignItems: "center",
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    fareModalCancelText: {
      color: colors.textSecondary,
      fontSize: 15,
      fontWeight: "500",
    },
    fareModalConfirmBtn: {
      flex: 2,
      paddingVertical: 14,
      borderRadius: 14,
      backgroundColor: colors.accentGreen,
      alignItems: "center",
    },
    fareModalConfirmText: { color: "#fff", fontSize: 15, fontWeight: "600" },
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
