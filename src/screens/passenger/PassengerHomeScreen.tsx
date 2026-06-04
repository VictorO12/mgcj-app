import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Platform,
  Image,
  Alert,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../hooks/AuthContext";
import { useActiveRide } from "../../hooks/useActiveRide";
import { supabase } from "../../lib/supabase";
import RideTrackingSheet from "../../components/RideTrackingSheet";
import ProfileMenu from "../../components/ProfileMenu";
import RideHistoryScreen from "../shared/RideHistoryScreen";
import ScheduledRidesScreen from "./ScheduledRidesScreen";
import PaymentMethodsScreen from "./PaymentMethodsScreen";
import Constants from "expo-constants";
import { useNotifications } from "../../hooks/useNotifications";
import RideReviewModal from "../../components/RideReviewModal";
import ProfileScreen from "./ProfileScreen";
import NotificationsScreen from "./NotificationsScreen";
import HelpSupportScreen from "./HelpSupportScreen";

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey;

const QUICK_DESTINATIONS = [
  {
    label: "🏥 Valley Hospital",
    address: "Valley Regional Hospital, Kentville, NS",
  },
  { label: "🛒 Superstore", address: "Atlantic Superstore, New Minas, NS" },
  { label: "🎓 Acadia", address: "Acadia University, Wolfville, NS" },
  { label: "💊 Pharmasave", address: "Pharmasave, Kentville, NS" },
];

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

interface PlacePrediction {
  place_id: string;
  description: string;
}
interface LatLng {
  latitude: number;
  longitude: number;
}
interface ActiveDriver {
  id: string;
  current_lat: number;
  current_lng: number;
  name: string | null;
  vehicle_make: string | null;
}

const VALLEY_REGION = {
  latitude: 45.0773,
  longitude: -64.3601,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};

export default function PassengerHomeScreen() {
  const { profile, signOut } = useAuth();
  const { ride, eta, statusLabel } = useActiveRide(profile?.id);
  useNotifications(); // registers push token for passenger notifications
  const mapRef = useRef<MapView>(null);

  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [pickupCoords, setPickupCoords] = useState<LatLng | null>(null);
  const [dropoffCoords, setDropoffCoords] = useState<LatLng | null>(null);
  const [pickupText, setPickupText] = useState("My location");
  const [dropoffText, setDropoffText] = useState("");
  const [activeField, setActiveField] = useState<"pickup" | "dropoff" | null>(
    null,
  );
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [fareEstimate, setFareEstimate] = useState<number | null>(null);
  const [fareLoading, setFareLoading] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [sheet, setSheet] = useState<"search" | "confirm" | null>(null);
  const [activeDrivers, setActiveDrivers] = useState<ActiveDriver[]>([]);
  const [menuVisible, setMenuVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [scheduledVisible, setScheduledVisible] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [profileVisible, setProfileVisible] = useState(false);
  const [notificationsVisible, setNotificationsVisible] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);

  // Payment state
  const [defaultCard, setDefaultCard] = useState<PaymentMethod | null>(null);
  const [selectedPayment, setSelectedPayment] = useState<"card" | "cash">(
    "cash",
  );
  const selectedPaymentRef = useRef<"card" | "cash">("cash");
  const defaultCardRef = useRef<PaymentMethod | null>(null);
  const [showCardNudge, setShowCardNudge] = useState(false);
  const lastCompletedRideId = useRef<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{
    rideId: string;
    driverId: string;
    driverName: string | null;
  } | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    selectedPaymentRef.current = selectedPayment;
  }, [selectedPayment]);
  useEffect(() => {
    defaultCardRef.current = defaultCard;
  }, [defaultCard]);

  // Fetch default card on mount and whenever profile changes
  useEffect(() => {
    if (profile) fetchDefaultCard();
  }, [profile]);

  // When confirm sheet opens, default to card if one exists
  useEffect(() => {
    if (sheet === "confirm") {
      setSelectedPayment(defaultCard ? "card" : "cash");
    }
  }, [sheet, defaultCard]);

  async function fetchDefaultCard() {
    if (!profile) return;
    const { data } = await supabase
      .from("payment_methods")
      .select("id, brand, last4, exp_month, exp_year, is_default")
      .eq("passenger_id", profile.id)
      .eq("is_default", true)
      .single();

    if (data) {
      setDefaultCard(data);
    } else {
      setDefaultCard(null);
      // Show nudge if no card saved at all
      const { count } = await supabase
        .from("payment_methods")
        .select("id", { count: "exact", head: true })
        .eq("passenger_id", profile.id);
      setShowCardNudge((count ?? 0) === 0);
    }
  }
  const [isScheduled, setIsScheduled] = useState(false);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedCalDay, setSelectedCalDay] = useState<Date | null>(null); // just date portion
  const [selectedTime, setSelectedTime] = useState<string | null>(null); // "HH:MM" 24h
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

  // Derive final scheduled date whenever day+time both picked
  useEffect(() => {
    if (selectedCalDay && selectedTime) {
      const [h, m] = selectedTime.split(":").map(Number);
      const d = new Date(selectedCalDay);
      d.setHours(h, m, 0, 0);
      setScheduledDate(d);
    } else {
      setScheduledDate(null);
    }
  }, [selectedCalDay, selectedTime]);

  // Calendar helpers
  function calDaysInMonth(y: number, mo: number) {
    return new Date(y, mo + 1, 0).getDate();
  }
  function calFirstWeekday(y: number, mo: number) {
    return new Date(y, mo, 1).getDay();
  } // 0=Sun

  const CAL_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setDate(today.getDate() + 60);

  function buildCalGrid(): (Date | null)[] {
    const y = calMonth.getFullYear(),
      mo = calMonth.getMonth();
    const totalDays = calDaysInMonth(y, mo);
    const startWd = calFirstWeekday(y, mo);
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startWd; i++) cells.push(null);
    for (let d = 1; d <= totalDays; d++) cells.push(new Date(y, mo, d));
    return cells;
  }

  function isDateSelectable(d: Date): boolean {
    const dd = new Date(d);
    dd.setHours(0, 0, 0, 0);
    return dd >= today && dd <= maxDate;
  }

  function isSameDay(a: Date, b: Date) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  // Time slots for selected day: every 30 min, skip past times if today
  function buildTimeSlots(): string[] {
    const slots: string[] = [];
    const isToday = selectedCalDay ? isSameDay(selectedCalDay, today) : false;
    const nowMins = isToday
      ? new Date().getHours() * 60 + new Date().getMinutes() + 30
      : 0;
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        if (isToday && h * 60 + m < nowMins) continue;
        slots.push(
          `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        );
      }
    }
    return slots;
  }

  function formatTimeSlot(t: string): string {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  function formatScheduledDate(d: Date): string {
    return d.toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

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
      setUserLocation(coords);
      setPickupCoords(coords);
      mapRef.current?.animateToRegion(
        { ...coords, latitudeDelta: 0.08, longitudeDelta: 0.08 },
        800,
      );
      const [place] = await Location.reverseGeocodeAsync(coords);
      if (place)
        setPickupText(
          [place.name, place.street].filter(Boolean).join(", ") ||
            "My location",
        );
    })();
  }, []);

  useEffect(() => {
    fetchActiveDrivers();
    const interval = setInterval(fetchActiveDrivers, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (
      ride?.status === "completed" &&
      ride.driver?.id &&
      ride.id !== lastCompletedRideId.current
    ) {
      lastCompletedRideId.current = ride.id;
      setTimeout(() => {
        setReviewTarget({
          rideId: ride.id,
          driverId: ride.driver!.id,
          driverName: ride.driver!.name ?? null,
        });
      }, 800);
    }
  }, [ride?.status, ride?.id]);

  async function fetchActiveDrivers() {
    const { data } = await supabase
      .from("drivers")
      .select("id, current_lat, current_lng, vehicle_make")
      .eq("is_active", true)
      .not("current_lat", "is", null);
    if (!data) return;
    const withNames = await Promise.all(
      data.map(async (d) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name")
          .eq("id", d.id)
          .single();
        return { ...d, name: p?.name ?? null };
      }),
    );
    setActiveDrivers(
      withNames.filter((d) => d.current_lat && d.current_lng) as ActiveDriver[],
    );
  }

  async function searchPlaces(query: string) {
    if (query.length < 3) {
      setPredictions([]);
      return;
    }
    setSearchLoading(true);
    try {
      const loc = userLocation
        ? `&location=${userLocation.latitude},${userLocation.longitude}&radius=30000`
        : "";
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&key=${MAPS_KEY}&components=country:ca${loc}`,
      );
      setPredictions((await res.json()).predictions ?? []);
    } catch (e) {
      console.error(e);
    }
    setSearchLoading(false);
  }

  async function selectPlace(prediction: PlacePrediction) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${prediction.place_id}&fields=geometry&key=${MAPS_KEY}`,
      );
      const loc = (await res.json()).result?.geometry?.location;
      if (!loc) return;
      const coords = { latitude: loc.lat, longitude: loc.lng };
      if (activeField === "pickup") {
        setPickupCoords(coords);
        setPickupText(prediction.description.split(",")[0]);
      } else {
        setDropoffCoords(coords);
        setDropoffText(prediction.description.split(",")[0]);
      }
      setPredictions([]);
      setActiveField(null);
      const pickup = activeField === "pickup" ? coords : pickupCoords;
      const dropoff = activeField === "dropoff" ? coords : dropoffCoords;
      if (pickup && dropoff) {
        setSheet("confirm");
        getFareEstimate(pickup, dropoff);
        mapRef.current?.fitToCoordinates([pickup, dropoff], {
          edgePadding: { top: 80, right: 60, bottom: 380, left: 60 },
          animated: true,
        });
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function getFareEstimate(pickup: LatLng, dropoff: LatLng) {
    setFareLoading(true);
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.latitude},${pickup.longitude}&destination=${dropoff.latitude},${dropoff.longitude}&key=${MAPS_KEY}`,
      );
      const metres =
        (await res.json()).routes?.[0]?.legs?.[0]?.distance?.value ?? 0;
      setFareEstimate(Math.round((4 + (metres / 1000) * 1.8) * 100) / 100);
    } catch (e) {
      console.error(e);
    }
    setFareLoading(false);
  }

  async function confirmBooking() {
    if (!pickupCoords || !dropoffCoords || !profile) {
      Alert.alert("Missing info", "Please set both pickup and dropoff.");
      return;
    }
    if (isScheduled && !scheduledDate) {
      Alert.alert(
        "Pick a time",
        "Please select a date and time for your scheduled ride.",
      );
      return;
    }
    setBookingLoading(true);

    const scheduledAt =
      isScheduled && scheduledDate ? scheduledDate.toISOString() : null;

    const paymentMethod = selectedPaymentRef.current;
    const paymentCard = defaultCardRef.current;

    console.log("[confirmBooking] selectedPayment state:", selectedPayment);
    console.log(
      "[confirmBooking] selectedPaymentRef:",
      selectedPaymentRef.current,
    );
    console.log("[confirmBooking] defaultCard state:", defaultCard?.id);
    console.log("[confirmBooking] defaultCardRef:", defaultCardRef.current?.id);
    console.log("[confirmBooking] using paymentMethod:", paymentMethod);

    const { error } = await supabase
      .from("rides")
      .insert({
        passenger_id: profile.id,
        status: "pending",
        pickup_address: pickupText,
        pickup_lat: pickupCoords.latitude,
        pickup_lng: pickupCoords.longitude,
        dropoff_address: dropoffText,
        dropoff_lat: dropoffCoords.latitude,
        dropoff_lng: dropoffCoords.longitude,
        fare_estimate: fareEstimate,
        payment_method: paymentMethod,
        payment_method_id:
          paymentMethod === "card" && paymentCard ? paymentCard.id : null,
        scheduled_at: scheduledAt,
      })
      .select()
      .single();

    setBookingLoading(false);
    if (error) {
      Alert.alert("Booking failed", error.message);
      return;
    }

    if (isScheduled && scheduledDate) {
      Alert.alert(
        "Ride scheduled! 🗓",
        `Your ride is booked for ${formatScheduledDate(scheduledDate)}. You can view or cancel it from the scheduled rides panel.`,
        [{ text: "OK" }],
      );
    }

    resetBookingUI();
  }

  async function cancelRide() {
    if (!ride) return;
    await supabase
      .from("rides")
      .update({ status: "cancelled" })
      .eq("id", ride.id);
  }

  function resetBookingUI() {
    setDropoffText("");
    setDropoffCoords(null);
    setFareEstimate(null);
    setSheet(null);
    setPredictions([]);
    setActiveField(null);
    setIsScheduled(false);
    setScheduledDate(null);
    setSelectedCalDay(null);
    setSelectedTime(null);
    if (userLocation)
      mapRef.current?.animateToRegion(
        { ...userLocation, latitudeDelta: 0.08, longitudeDelta: 0.08 },
        600,
      );
  }

  const hasActiveRide = !!ride;
  const myDriverId = ride?.driver?.id;

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
        {activeDrivers.map((d) => (
          <Marker
            key={d.id}
            coordinate={{ latitude: d.current_lat, longitude: d.current_lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            title={d.name ?? "Driver"}
            description={d.vehicle_make ?? ""}
          >
            <View
              style={[
                styles.driverMarker,
                myDriverId === d.id && styles.driverMarkerMine,
              ]}
            >
              <Text style={styles.driverMarkerText}>🚗</Text>
            </View>
          </Marker>
        ))}
        {!hasActiveRide && pickupCoords && pickupText !== "My location" && (
          <Marker coordinate={pickupCoords} pinColor="#4a9eff" title="Pickup" />
        )}
        {!hasActiveRide && dropoffCoords && (
          <Marker
            coordinate={dropoffCoords}
            pinColor="#E8500A"
            title="Drop-off"
          />
        )}
      </MapView>

      {/* Top bar */}
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.topName}>
            {hasActiveRide
              ? "Your ride"
              : `Hey ${profile?.name?.split(" ")[0] ?? "there"}`}
          </Text>
          <Text style={styles.topSub}>
            {hasActiveRide
              ? statusLabel(ride.status, ride.driver?.name)
              : "Where are you headed?"}
          </Text>
        </View>
        <View style={styles.topActions}>
          {/* Scheduled rides button */}
          {!hasActiveRide && (
            <TouchableOpacity
              style={styles.calendarBtn}
              onPress={() => setScheduledVisible(true)}
            >
              <Ionicons name="calendar-outline" size={20} color="#A855F7" />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.avatarBtn}
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
          </TouchableOpacity>
        </View>
      </View>

      {activeDrivers.length > 0 && (
        <View style={styles.driversPill}>
          <View style={styles.driversPillDot} />
          <Text style={styles.driversPillText}>
            {activeDrivers.length} driver{activeDrivers.length > 1 ? "s" : ""}{" "}
            nearby
          </Text>
        </View>
      )}

      {userLocation && (
        <TouchableOpacity
          style={styles.recenterBtn}
          onPress={() =>
            mapRef.current?.animateToRegion(
              { ...userLocation, latitudeDelta: 0.08, longitudeDelta: 0.08 },
              600,
            )
          }
        >
          <Ionicons name="locate" size={20} color="#F1F5F9" />
        </TouchableOpacity>
      )}

      {!hasActiveRide && (
        <View style={styles.sheet}>
          {/* Pickup / Dropoff inputs */}
          <View style={styles.inputsCard}>
            <TouchableOpacity
              style={styles.inputRow}
              onPress={() => {
                setActiveField("pickup");
                setSheet("search");
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.inputDot, { backgroundColor: "#4a9eff" }]} />
              <Text
                style={[styles.inputText, !pickupText && styles.placeholder]}
                numberOfLines={1}
              >
                {pickupText || "Pickup location"}
              </Text>
            </TouchableOpacity>
            <View style={styles.inputDivider} />
            <TouchableOpacity
              style={styles.inputRow}
              onPress={() => {
                setActiveField("dropoff");
                setSheet("search");
              }}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.inputDot,
                  { backgroundColor: "#E8500A", borderRadius: 3 },
                ]}
              />
              <Text
                style={[styles.inputText, !dropoffText && styles.placeholder]}
                numberOfLines={1}
              >
                {dropoffText || "Where to?"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Search box */}
          {sheet === "search" && (
            <View style={styles.searchBox}>
              <Ionicons
                name="search"
                size={16}
                color="#6B7280"
                style={{ marginRight: 8 }}
              />
              <TextInput
                style={styles.searchInput}
                placeholder={
                  activeField === "pickup"
                    ? "Search pickup..."
                    : "Search destination..."
                }
                placeholderTextColor="#6B7280"
                autoFocus
                onChangeText={(t) => {
                  activeField === "dropoff"
                    ? setDropoffText(t)
                    : setPickupText(t);
                  searchPlaces(t);
                }}
                value={activeField === "dropoff" ? dropoffText : pickupText}
              />
              {searchLoading && (
                <ActivityIndicator size="small" color="#E8500A" />
              )}
              <TouchableOpacity
                onPress={() => {
                  setSheet(null);
                  setActiveField(null);
                  setPredictions([]);
                }}
              >
                <Ionicons name="close" size={18} color="#6B7280" />
              </TouchableOpacity>
            </View>
          )}

          {/* Predictions */}
          {predictions.length > 0 && (
            <ScrollView
              style={styles.predictionsList}
              keyboardShouldPersistTaps="handled"
            >
              {predictions.map((p) => (
                <TouchableOpacity
                  key={p.place_id}
                  style={styles.predictionRow}
                  onPress={() => selectPlace(p)}
                >
                  <Ionicons
                    name="location-outline"
                    size={16}
                    color="#6B7280"
                    style={{ marginRight: 10 }}
                  />
                  <Text style={styles.predictionText} numberOfLines={2}>
                    {p.description}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Quick destinations */}
          {sheet === null && predictions.length === 0 && (
            <>
              <Text style={styles.sectionLabel}>QUICK DESTINATIONS</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {QUICK_DESTINATIONS.map((d) => (
                  <TouchableOpacity
                    key={d.label}
                    style={styles.quickChip}
                    onPress={() => {
                      setDropoffText(d.label.replace(/^.{2}/, "").trim());
                      setActiveField("dropoff");
                      searchPlaces(d.address);
                      setSheet("search");
                    }}
                  >
                    <Text style={styles.quickChipText}>{d.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}

          {/* Confirm sheet */}
          {sheet === "confirm" && (
            <View>
              <Text style={styles.confirmTitle}>Confirm your ride</Text>

              {/* Route card */}
              <View style={styles.routeCard}>
                <View style={styles.routeRow}>
                  <View
                    style={[styles.routeDot, { backgroundColor: "#4a9eff" }]}
                  />
                  <Text style={styles.routeText} numberOfLines={1}>
                    {pickupText}
                  </Text>
                </View>
                <View style={styles.routeLine} />
                <View style={styles.routeRow}>
                  <View
                    style={[
                      styles.routeDot,
                      { backgroundColor: "#E8500A", borderRadius: 3 },
                    ]}
                  />
                  <Text style={styles.routeText} numberOfLines={1}>
                    {dropoffText}
                  </Text>
                </View>
              </View>

              {/* Schedule toggle */}
              <TouchableOpacity
                style={[
                  styles.scheduleToggle,
                  isScheduled && styles.scheduleToggleActive,
                ]}
                onPress={() => {
                  const next = !isScheduled;
                  setIsScheduled(next);
                  if (!next) {
                    setSelectedCalDay(null);
                    setSelectedTime(null);
                  }
                }}
                activeOpacity={0.8}
              >
                <View style={styles.scheduleToggleLeft}>
                  <Ionicons
                    name={isScheduled ? "calendar" : "calendar-outline"}
                    size={16}
                    color={isScheduled ? "#A855F7" : "#6B7280"}
                  />
                  <Text
                    style={[
                      styles.scheduleToggleText,
                      isScheduled && styles.scheduleToggleTextActive,
                    ]}
                  >
                    {isScheduled ? "Scheduled for later" : "Schedule for later"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.togglePill,
                    isScheduled && styles.togglePillActive,
                  ]}
                >
                  <View
                    style={[
                      styles.toggleThumb,
                      isScheduled && styles.toggleThumbActive,
                    ]}
                  />
                </View>
              </TouchableOpacity>

              {/* Inline calendar + time picker */}
              {isScheduled && (
                <View style={styles.calendarWrap}>
                  {/* Month nav */}
                  <View style={styles.calHeader}>
                    <TouchableOpacity
                      style={styles.calNavBtn}
                      onPress={() => {
                        const prev = new Date(
                          calMonth.getFullYear(),
                          calMonth.getMonth() - 1,
                          1,
                        );
                        const thisMonth = new Date(
                          today.getFullYear(),
                          today.getMonth(),
                          1,
                        );
                        if (prev >= thisMonth) setCalMonth(prev);
                      }}
                    >
                      <Ionicons name="chevron-back" size={18} color="#6B7280" />
                    </TouchableOpacity>
                    <Text style={styles.calMonthLabel}>
                      {CAL_MONTHS[calMonth.getMonth()]} {calMonth.getFullYear()}
                    </Text>
                    <TouchableOpacity
                      style={styles.calNavBtn}
                      onPress={() =>
                        setCalMonth(
                          new Date(
                            calMonth.getFullYear(),
                            calMonth.getMonth() + 1,
                            1,
                          ),
                        )
                      }
                    >
                      <Ionicons
                        name="chevron-forward"
                        size={18}
                        color="#6B7280"
                      />
                    </TouchableOpacity>
                  </View>

                  {/* Weekday labels */}
                  <View style={styles.calWeekRow}>
                    {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                      <Text key={d} style={styles.calWeekLabel}>
                        {d}
                      </Text>
                    ))}
                  </View>

                  {/* Day grid */}
                  <View style={styles.calGrid}>
                    {buildCalGrid().map((day, idx) => {
                      if (!day)
                        return <View key={`e-${idx}`} style={styles.calCell} />;
                      const selectable = isDateSelectable(day);
                      const isSelected = selectedCalDay
                        ? isSameDay(day, selectedCalDay)
                        : false;
                      const isToday2 = isSameDay(day, today);
                      return (
                        <TouchableOpacity
                          key={day.toISOString()}
                          style={[
                            styles.calCell,
                            isSelected && styles.calCellSelected,
                            isToday2 && !isSelected && styles.calCellToday,
                          ]}
                          onPress={() => {
                            if (!selectable) return;
                            setSelectedCalDay(day);
                            setSelectedTime(null); // reset time when date changes
                          }}
                          disabled={!selectable}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.calDayText,
                              !selectable && styles.calDayDisabled,
                              isSelected && styles.calDaySelected,
                              isToday2 && !isSelected && styles.calDayToday,
                            ]}
                          >
                            {day.getDate()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Time scroll — appears after a day is picked */}
                  {selectedCalDay && (
                    <View style={styles.timeSection}>
                      <Text style={styles.timeSectionLabel}>Pick a time</Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.timeScrollContent}
                      >
                        {buildTimeSlots().map((slot) => (
                          <TouchableOpacity
                            key={slot}
                            style={[
                              styles.timeChip,
                              selectedTime === slot && styles.timeChipSelected,
                            ]}
                            onPress={() => setSelectedTime(slot)}
                            activeOpacity={0.75}
                          >
                            <Text
                              style={[
                                styles.timeChipText,
                                selectedTime === slot &&
                                  styles.timeChipTextSelected,
                              ]}
                            >
                              {formatTimeSlot(slot)}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  {/* Summary once both picked */}
                  {scheduledDate && (
                    <View style={styles.schedSummary}>
                      <Ionicons
                        name="checkmark-circle"
                        size={15}
                        color="#A855F7"
                      />
                      <Text style={styles.schedSummaryText}>
                        {formatScheduledDate(scheduledDate)}
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Payment selector */}
              <View style={styles.paymentSection}>
                <Text style={styles.paymentLabel}>Payment</Text>
                <View style={styles.paymentOptions}>
                  {/* Card option — only shown if a card is saved */}
                  {defaultCard ? (
                    <TouchableOpacity
                      style={[
                        styles.paymentOption,
                        selectedPayment === "card" &&
                          styles.paymentOptionSelected,
                      ]}
                      onPress={() => setSelectedPayment("card")}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name="card"
                        size={16}
                        color={
                          selectedPayment === "card" ? "#E8500A" : "#6B7280"
                        }
                      />
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.paymentOptionTitle,
                            selectedPayment === "card" &&
                              styles.paymentOptionTitleSelected,
                          ]}
                        >
                          {defaultCard.brand} ••{defaultCard.last4}
                        </Text>
                      </View>
                      {selectedPayment === "card" && (
                        <Ionicons
                          name="checkmark-circle"
                          size={16}
                          color="#E8500A"
                        />
                      )}
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.addCardPrompt}
                      onPress={() => setPaymentVisible(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name="add-circle-outline"
                        size={16}
                        color="#E8500A"
                      />
                      <Text style={styles.addCardPromptText}>
                        Add a card for faster checkout
                      </Text>
                    </TouchableOpacity>
                  )}

                  {/* Cash option */}
                  <TouchableOpacity
                    style={[
                      styles.paymentOption,
                      selectedPayment === "cash" &&
                        styles.paymentOptionSelected,
                    ]}
                    onPress={() => setSelectedPayment("cash")}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name="cash-outline"
                      size={16}
                      color={selectedPayment === "cash" ? "#E8500A" : "#6B7280"}
                    />
                    <Text
                      style={[
                        styles.paymentOptionTitle,
                        selectedPayment === "cash" &&
                          styles.paymentOptionTitleSelected,
                      ]}
                    >
                      Cash
                    </Text>
                    {selectedPayment === "cash" && (
                      <Ionicons
                        name="checkmark-circle"
                        size={16}
                        color="#E8500A"
                      />
                    )}
                  </TouchableOpacity>
                </View>
              </View>

              {/* Fare row */}
              <View style={styles.fareRow}>
                <View>
                  <Text style={styles.fareLabel}>Estimated fare</Text>
                  <Text style={styles.fareNote}>
                    {selectedPayment === "card" ? "Card · " : "Cash · "}
                    Subject to final distance
                  </Text>
                </View>
                {fareLoading ? (
                  <ActivityIndicator color="#E8500A" />
                ) : (
                  <Text style={styles.fareAmount}>
                    ${fareEstimate?.toFixed(2) ?? "--"}
                  </Text>
                )}
              </View>

              {/* Action buttons */}
              <View style={styles.confirmBtns}>
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={resetBookingUI}
                >
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.bookBtn, bookingLoading && { opacity: 0.6 }]}
                  onPress={confirmBooking}
                  disabled={bookingLoading}
                >
                  {bookingLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.bookBtnText}>
                      {isScheduled ? "Schedule ride" : "Book ride"}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Card nudge — shown on home sheet when no card saved */}
          {sheet === null && showCardNudge && (
            <TouchableOpacity
              style={styles.cardNudge}
              onPress={() => setPaymentVisible(true)}
              activeOpacity={0.85}
            >
              <View style={styles.cardNudgeIcon}>
                <Ionicons name="card-outline" size={18} color="#E8500A" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardNudgeTitle}>
                  Add a card for easier payment
                </Text>
                <Text style={styles.cardNudgeSub}>
                  Pay rides without handling cash
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowCardNudge(false)}>
                <Ionicons name="close" size={16} color="#4B5563" />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        </View>
      )}

      {hasActiveRide && (
        <RideTrackingSheet
          ride={ride}
          eta={eta}
          statusLabel={statusLabel(ride.status, ride.driver?.name)}
          onCancel={cancelRide}
          activeDrivers={activeDrivers}
        />
      )}

      {historyVisible && (
        <View style={StyleSheet.absoluteFill}>
          <RideHistoryScreen onClose={() => setHistoryVisible(false)} />
        </View>
      )}

      {profileVisible && (
        <View style={StyleSheet.absoluteFill}>
          <ProfileScreen
            onClose={() => setProfileVisible(false)}
            onDeleteAccount={signOut}
          />
        </View>
      )}
      {notificationsVisible && (
        <View style={StyleSheet.absoluteFill}>
          <NotificationsScreen onClose={() => setNotificationsVisible(false)} />
        </View>
      )}
      {helpVisible && (
        <View style={StyleSheet.absoluteFill}>
          <HelpSupportScreen onClose={() => setHelpVisible(false)} />
        </View>
      )}

      {scheduledVisible && (
        <View style={StyleSheet.absoluteFill}>
          <ScheduledRidesScreen onClose={() => setScheduledVisible(false)} />
        </View>
      )}

      {paymentVisible && (
        <View style={StyleSheet.absoluteFill}>
          <PaymentMethodsScreen
            onClose={() => {
              setPaymentVisible(false);
              fetchDefaultCard(); // refresh in case they added/changed a card
            }}
          />
        </View>
      )}

      <ProfileMenu
        profile={profile}
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        onSignOut={signOut}
        onOpenPaymentMethods={() => setPaymentVisible(true)}
        onOpenHistory={() => setHistoryVisible(true)}
        onOpenProfile={() => setProfileVisible(true)}
        onOpenNotifications={() => setNotificationsVisible(true)}
        onOpenHelp={() => setHelpVisible(true)}
      />

      {/* ── Post-ride review popup ── */}
      {reviewTarget && (
        <RideReviewModal
          visible={!!reviewTarget}
          rideId={reviewTarget.rideId}
          driverId={reviewTarget.driverId}
          driverName={reviewTarget.driverName}
          onDismiss={() => setReviewTarget(null)}
        />
      )}
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
    paddingTop: Platform.OS === "ios" ? 56 : 40,
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: "rgba(17,24,39,0.88)",
  },
  topName: { fontSize: 20, fontWeight: "700", color: "#F1F5F9" },
  topSub: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  topActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
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
  topAvatarInitials: {
    fontSize: 13,
    fontWeight: "700",
    color: "#93C5FD",
  },
  calendarBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(168,85,247,0.12)",
    borderWidth: 0.5,
    borderColor: "rgba(168,85,247,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBtn: { padding: 4 },
  driversPill: {
    position: "absolute",
    top: Platform.OS === "ios" ? 110 : 96,
    left: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(30,42,58,0.92)",
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  driversPillDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#1D9E75",
  },
  driversPillText: { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },
  recenterBtn: {
    position: "absolute",
    right: 16,
    bottom: 320,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#1E2A3A",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  driverMarker: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    padding: 5,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.15)",
  },
  driverMarkerMine: { borderColor: "#E8500A", backgroundColor: "#2A1A0E" },
  driverMarkerText: { fontSize: 16 },
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
    paddingBottom: 36,
    minHeight: 280,
  },
  inputsCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 14,
    overflow: "hidden",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inputDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  inputDivider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.07)",
    marginHorizontal: 16,
  },
  inputText: { fontSize: 15, color: "#F1F5F9", flex: 1 },
  placeholder: { color: "#4B5563" },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 15, color: "#F1F5F9" },
  predictionsList: { maxHeight: 220 },
  predictionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  predictionText: { fontSize: 13, color: "#CBD5E1", flex: 1, lineHeight: 18 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: "#374151",
    letterSpacing: 0.08,
    marginBottom: 10,
    marginTop: 4,
  },
  quickChip: {
    backgroundColor: "#1E2A3A",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginRight: 8,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  quickChipText: { fontSize: 13, color: "#CBD5E1" },
  confirmTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 16,
  },
  routeCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 12,
  },
  routeRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  routeDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  routeLine: {
    width: 1,
    height: 14,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginLeft: 4.5,
    marginVertical: 2,
  },
  routeText: { fontSize: 14, color: "#CBD5E1", flex: 1 },

  // Schedule toggle
  scheduleToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  scheduleToggleActive: {
    borderColor: "rgba(168,85,247,0.4)",
    backgroundColor: "rgba(168,85,247,0.08)",
  },
  scheduleToggleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  scheduleToggleText: {
    fontSize: 14,
    color: "#6B7280",
    fontWeight: "500",
  },
  scheduleToggleTextActive: {
    color: "#A855F7",
  },
  togglePill: {
    width: 38,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#374151",
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  togglePillActive: {
    backgroundColor: "#A855F7",
  },
  toggleThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#9CA3AF",
    alignSelf: "flex-start",
  },
  toggleThumbActive: {
    backgroundColor: "#fff",
    alignSelf: "flex-end",
  },

  // Inline calendar
  calendarWrap: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: "rgba(168,85,247,0.25)",
    padding: 12,
    marginBottom: 12,
  },
  calHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  calNavBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  calMonthLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F1F5F9",
  },
  calWeekRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  calWeekLabel: {
    flex: 1,
    textAlign: "center",
    fontSize: 10,
    fontWeight: "600",
    color: "#4B5563",
    textTransform: "uppercase",
  },
  calGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  calCell: {
    width: `${100 / 7}%` as any,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 100,
  },
  calCellSelected: {
    backgroundColor: "#A855F7",
  },
  calCellToday: {
    borderWidth: 1,
    borderColor: "rgba(168,85,247,0.5)",
  },
  calDayText: {
    fontSize: 13,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  calDayDisabled: {
    color: "#2D3748",
  },
  calDaySelected: {
    color: "#fff",
    fontWeight: "700",
  },
  calDayToday: {
    color: "#A855F7",
    fontWeight: "700",
  },

  // Time scroll
  timeSection: {
    marginTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.06)",
    paddingTop: 10,
  },
  timeSectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  timeScrollContent: {
    gap: 8,
    paddingRight: 4,
  },
  timeChip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "#111827",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  timeChipSelected: {
    backgroundColor: "rgba(168,85,247,0.2)",
    borderColor: "#A855F7",
  },
  timeChipText: {
    fontSize: 13,
    color: "#6B7280",
    fontWeight: "500",
  },
  timeChipTextSelected: {
    color: "#E9D5FF",
    fontWeight: "600",
  },

  // Schedule summary
  schedSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  schedSummaryText: {
    fontSize: 13,
    color: "#A855F7",
    fontWeight: "600",
  },

  // Scheduled date display row (kept for reference, unused now)
  scheduledDateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(168,85,247,0.08)",
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: "rgba(168,85,247,0.3)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  scheduledDateText: {
    flex: 1,
    fontSize: 13,
    color: "#E9D5FF",
    fontWeight: "500",
  },

  // Payment selector
  paymentSection: {
    marginBottom: 12,
  },
  paymentLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  paymentOptions: {
    gap: 8,
  },
  paymentOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#1E2A3A",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  paymentOptionSelected: {
    borderColor: "rgba(232,80,10,0.4)",
    backgroundColor: "rgba(232,80,10,0.07)",
  },
  paymentOptionTitle: {
    fontSize: 14,
    color: "#6B7280",
    fontWeight: "500",
    flex: 1,
  },
  paymentOptionTitleSelected: {
    color: "#F1F5F9",
  },
  addCardPrompt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(232,80,10,0.06)",
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.25)",
    borderStyle: "dashed",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  addCardPromptText: {
    fontSize: 13,
    color: "#E8500A",
    fontWeight: "500",
    flex: 1,
  },

  // Card nudge banner
  cardNudge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(232,80,10,0.07)",
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.2)",
    padding: 12,
    marginTop: 10,
  },
  cardNudgeIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "rgba(232,80,10,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardNudgeTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F1F5F9",
    marginBottom: 2,
  },
  cardNudgeSub: {
    fontSize: 11,
    color: "#6B7280",
  },

  fareRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 20,
  },
  fareLabel: { fontSize: 14, color: "#9CA3AF", marginBottom: 3 },
  fareNote: { fontSize: 11, color: "#4B5563" },
  fareAmount: { fontSize: 28, fontWeight: "700", color: "#F1F5F9" },
  confirmBtns: { flexDirection: "row", gap: 12 },
  editBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  editBtnText: { color: "#9CA3AF", fontSize: 15, fontWeight: "500" },
  bookBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#E8500A",
    alignItems: "center",
  },
  bookBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
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
