import React, { useState, useEffect, useRef, useCallback } from "react";
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
  KeyboardAvoidingView,
  Dimensions,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
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
import DriverProfileSheet from "../../components/DriverProfileSheet";

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsRoutingKey;
const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl;
const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey;
const SCREEN_HEIGHT = Dimensions.get("window").height;

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
const BUSY_STATUSES = ["offered", "assigned", "driver_arriving", "in_progress"];

export default function PassengerHomeScreen() {
  const { profile, signOut } = useAuth();
  const { ride, eta, statusLabel, cancelledReason, clearCancelledReason } =
    useActiveRide(profile?.id);
  useNotifications();

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
  const [driverProfileVisible, setDriverProfileVisible] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);

  const [rideRouteCoords, setRideRouteCoords] = useState<LatLng[]>([]);
  const lastRouteFetchStatus = useRef<string | null>(null);
  const routeDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    selectedPaymentRef.current = selectedPayment;
  }, [selectedPayment]);
  useEffect(() => {
    defaultCardRef.current = defaultCard;
  }, [defaultCard]);
  useEffect(() => {
    if (profile) fetchDefaultCard();
  }, [profile]);
  useEffect(() => {
    if (sheet === "confirm") setSelectedPayment(defaultCard ? "card" : "cash");
  }, [sheet, defaultCard]);

  const fetchRideRoute = useCallback(
    async (origin: LatLng, destination: LatLng) => {
      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/directions/json` +
            `?origin=${origin.latitude},${origin.longitude}` +
            `&destination=${destination.latitude},${destination.longitude}` +
            `&key=${MAPS_KEY}`,
        );
        const json = await res.json();
        const points = json.routes?.[0]?.overview_polyline?.points;
        if (points) setRideRouteCoords(decodePolyline(points));
      } catch (e) {
        console.error("[rideRoute]", e);
      }
    },
    [],
  );

  useEffect(() => {
    if (!ride?.driver?.current_lat || !ride?.driver?.current_lng) {
      setRideRouteCoords([]);
      lastRouteFetchStatus.current = null;
      return;
    }
    const statusChanged = ride.status !== lastRouteFetchStatus.current;
    if (statusChanged) {
      lastRouteFetchStatus.current = ride.status;
      const origin = {
        latitude: ride.driver.current_lat,
        longitude: ride.driver.current_lng,
      };
      const destination =
        ride.status === "in_progress"
          ? { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }
          : { latitude: ride.pickup_lat, longitude: ride.pickup_lng };
      fetchRideRoute(origin, destination);
      mapRef.current?.fitToCoordinates([origin, destination], {
        edgePadding: { top: 100, right: 60, bottom: 360, left: 60 },
        animated: true,
      });
      return;
    }
    if (routeDebounceTimer.current) clearTimeout(routeDebounceTimer.current);
    routeDebounceTimer.current = setTimeout(() => {
      const origin = {
        latitude: ride.driver!.current_lat!,
        longitude: ride.driver!.current_lng!,
      };
      const destination =
        ride.status === "in_progress"
          ? { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }
          : { latitude: ride.pickup_lat, longitude: ride.pickup_lng };
      fetchRideRoute(origin, destination);
    }, 10000);
    return () => {
      if (routeDebounceTimer.current) clearTimeout(routeDebounceTimer.current);
    };
  }, [ride?.status, ride?.driver?.current_lat, ride?.driver?.current_lng]);

  useEffect(() => {
    if (!ride) {
      setRideRouteCoords([]);
      lastRouteFetchStatus.current = null;
    }
  }, [ride]);

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
  const [selectedCalDay, setSelectedCalDay] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

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

  function calDaysInMonth(y: number, mo: number) {
    return new Date(y, mo + 1, 0).getDate();
  }
  function calFirstWeekday(y: number, mo: number) {
    return new Date(y, mo, 1).getDay();
  }
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
    const cells: (Date | null)[] = [];
    for (let i = 0; i < calFirstWeekday(y, mo); i++) cells.push(null);
    for (let d = 1; d <= calDaysInMonth(y, mo); d++)
      cells.push(new Date(y, mo, d));
    return cells;
  }
  function isDateSelectable(d: Date) {
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
  function buildTimeSlots(): string[] {
    const slots: string[] = [];
    const isToday = selectedCalDay ? isSameDay(selectedCalDay, today) : false;
    const nowMins = isToday
      ? new Date().getHours() * 60 + new Date().getMinutes() + 30
      : 0;
    for (let h = 0; h < 24; h++)
      for (const m of [0, 30]) {
        if (isToday && h * 60 + m < nowMins) continue;
        slots.push(
          `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        );
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
    if (cancelledReason === "timeout") {
      Alert.alert(
        "No drivers available",
        "We couldn't find a driver nearby. Please try again in a few minutes.",
        [{ text: "OK", onPress: clearCancelledReason }],
      );
    }
  }, [cancelledReason]);

  useEffect(() => {
    if (!ride) {
      fetchActiveDrivers();
      const interval = setInterval(fetchActiveDrivers, 15000);
      return () => clearInterval(interval);
    }
    setActiveDrivers([]);
  }, [!!ride]);

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
    const { data: drivers } = await supabase
      .from("drivers")
      .select("id, current_lat, current_lng, vehicle_make")
      .eq("is_active", true)
      .not("current_lat", "is", null);
    if (!drivers || drivers.length === 0) {
      setActiveDrivers([]);
      return;
    }
    const driverIds = drivers.map((d) => d.id);
    const { data: busyRides } = await supabase
      .from("rides")
      .select("driver_id")
      .in("status", BUSY_STATUSES)
      .in("driver_id", driverIds);
    const busyDriverIds = new Set((busyRides ?? []).map((r) => r.driver_id));
    const availableDrivers = drivers.filter((d) => !busyDriverIds.has(d.id));
    const withNames = await Promise.all(
      availableDrivers.map(async (d) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name")
          .eq("id", d.id)
          .maybeSingle();
        return { ...d, name: p?.name ?? null };
      }),
    );
    setActiveDrivers(
      withNames.filter((d) => d.current_lat && d.current_lng) as ActiveDriver[],
    );
  }

  function openDriverProfile(driverId: string) {
    setSelectedDriverId(driverId);
    setDriverProfileVisible(true);
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
    if (!isScheduled && activeDrivers.length === 0) {
      Alert.alert(
        "No drivers available",
        "There are no drivers online right now. Please try again shortly, or schedule a ride for later.",
      );
      return;
    }
    setBookingLoading(true);
    const scheduledAt =
      isScheduled && scheduledDate ? scheduledDate.toISOString() : null;
    const paymentMethod = selectedPaymentRef.current;
    const paymentCard = defaultCardRef.current;

    if (paymentMethod === "card") {
      try {
        if (!fareEstimate || fareEstimate <= 0) {
          setBookingLoading(false);
          Alert.alert(
            "Missing fare",
            "Could not calculate fare. Please try again.",
          );
          return;
        }
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("No session");
        const res = await fetch(
          `${SUPABASE_URL}/functions/v1/create-payment-intent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
              apikey: SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ fare_amount: fareEstimate }),
          },
        );
        const intentData = await res.json();
        if (!res.ok) {
          setBookingLoading(false);
          Alert.alert(
            "Payment failed",
            intentData.message ??
              "Could not process payment. Please try a different card or pay with cash.",
          );
          return;
        }
        const { error: rideError } = await supabase.from("rides").insert({
          passenger_id: profile.id,
          company_id: profile.company_id,
          status: scheduledAt ? "scheduled" : "pending",
          pickup_address: pickupText,
          pickup_lat: pickupCoords.latitude,
          pickup_lng: pickupCoords.longitude,
          dropoff_address: dropoffText,
          dropoff_lat: dropoffCoords.latitude,
          dropoff_lng: dropoffCoords.longitude,
          fare_estimate: fareEstimate,
          payment_method: "card",
          payment_method_id: paymentCard?.id ?? null,
          stripe_payment_intent_id: intentData.payment_intent_id,
          payment_status: "pending",
          scheduled_at: scheduledAt,
        });
        setBookingLoading(false);
        if (rideError) {
          Alert.alert("Booking failed", rideError.message);
          return;
        }
        if (isScheduled && scheduledDate)
          Alert.alert(
            "Ride scheduled! 🗓",
            `Your ride is booked for ${formatScheduledDate(scheduledDate)}.`,
            [{ text: "OK" }],
          );
        resetBookingUI();
        return;
      } catch (err) {
        console.error("Card booking error:", err);
        setBookingLoading(false);
        Alert.alert("Error", "Something went wrong. Please try again.");
        return;
      }
    }

    const { error: rideError } = await supabase.from("rides").insert({
      passenger_id: profile.id,
      company_id: profile.company_id,
      status: scheduledAt ? "scheduled" : "pending",
      pickup_address: pickupText,
      pickup_lat: pickupCoords.latitude,
      pickup_lng: pickupCoords.longitude,
      dropoff_address: dropoffText,
      dropoff_lat: dropoffCoords.latitude,
      dropoff_lng: dropoffCoords.longitude,
      fare_estimate: fareEstimate,
      payment_method: "cash",
      scheduled_at: scheduledAt,
    });
    setBookingLoading(false);
    if (rideError) {
      Alert.alert("Booking failed", rideError.message);
      return;
    }
    if (isScheduled && scheduledDate)
      Alert.alert(
        "Ride scheduled! 🗓",
        `Your ride is booked for ${formatScheduledDate(scheduledDate)}. You can view or cancel it from the scheduled rides panel.`,
        [{ text: "OK" }],
      );
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
  const noDriversForImmediate = !isScheduled && activeDrivers.length === 0;
  const hasDriver = !!ride?.driver?.current_lat && !!ride?.driver?.current_lng;
  const driverCoords: LatLng | null = hasDriver
    ? {
        latitude: ride!.driver!.current_lat!,
        longitude: ride!.driver!.current_lng!,
      }
    : null;
  const pickupPin: LatLng | null = ride
    ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
    : null;
  const dropoffPin: LatLng | null = ride
    ? { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }
    : null;
  const isInProgress = ride?.status === "in_progress";

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
        {!hasActiveRide &&
          activeDrivers.map((d) => (
            <Marker
              key={d.id}
              coordinate={{ latitude: d.current_lat, longitude: d.current_lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              onPress={() => openDriverProfile(d.id)}
            >
              <View style={styles.driverMarker}>
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
        {hasActiveRide && driverCoords && (
          <Marker coordinate={driverCoords} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.driverMarkerMine}>
              <Text style={styles.driverMarkerText}>🚗</Text>
            </View>
          </Marker>
        )}
        {hasActiveRide && !isInProgress && pickupPin && (
          <Marker coordinate={pickupPin} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.pinWrap}>
              <View style={[styles.pin, { backgroundColor: "#4a9eff" }]}>
                <Ionicons name="person" size={12} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: "#4a9eff" }]} />
            </View>
          </Marker>
        )}
        {hasActiveRide && isInProgress && dropoffPin && (
          <Marker coordinate={dropoffPin} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.pinWrap}>
              <View style={[styles.pin, { backgroundColor: "#E8500A" }]}>
                <Ionicons name="flag" size={12} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: "#E8500A" }]} />
            </View>
          </Marker>
        )}
        {hasActiveRide && rideRouteCoords.length > 0 && (
          <Polyline
            coordinates={rideRouteCoords}
            strokeColor={isInProgress ? "#E8500A" : "#4a9eff"}
            strokeWidth={3}
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

      {!hasActiveRide && activeDrivers.length > 0 && (
        <View style={styles.driversPill}>
          <View style={styles.driversPillDot} />
          <Text style={styles.driversPillText}>
            {activeDrivers.length} driver{activeDrivers.length > 1 ? "s" : ""}{" "}
            available
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

      {/* ── BOTTOM SHEET ── */}
      {!hasActiveRide && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.kavContainer}
          keyboardVerticalOffset={0}
        >
          <View style={styles.sheet}>
            {/* Input card — always visible except in confirm */}
            {sheet !== "confirm" && (
              <View style={styles.inputsCard}>
                <TouchableOpacity
                  style={styles.inputRow}
                  onPress={() => {
                    setActiveField("pickup");
                    setSheet("search");
                  }}
                  activeOpacity={0.8}
                >
                  <View
                    style={[styles.inputDot, { backgroundColor: "#4a9eff" }]}
                  />
                  <Text
                    style={[
                      styles.inputText,
                      !pickupText && styles.placeholder,
                    ]}
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
                    style={[
                      styles.inputText,
                      !dropoffText && styles.placeholder,
                    ]}
                    numberOfLines={1}
                  >
                    {dropoffText || "Where to?"}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

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

            {/* Predictions list */}
            {predictions.length > 0 && (
              <ScrollView
                style={styles.predictionsList}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
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

            {/* Idle state: quick destinations + card nudge */}
            {sheet === null && predictions.length === 0 && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.sectionLabel}>QUICK DESTINATIONS</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 4 }}
                >
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
                {showCardNudge && (
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
              </ScrollView>
            )}

            {/* ── CONFIRM SHEET ── */}
            {sheet === "confirm" && (
              <ScrollView
                style={styles.confirmScroll}
                contentContainerStyle={styles.confirmScrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                {/* Title + destination only */}
                <View style={styles.confirmHeader}>
                  <Text style={styles.confirmTitle}>Confirm your ride</Text>
                  <View style={styles.confirmDestRow}>
                    <View
                      style={[styles.routeDot, { backgroundColor: "#4a9eff" }]}
                    />
                    <Text style={styles.confirmDestText} numberOfLines={1}>
                      {pickupText}
                    </Text>
                  </View>
                  <View style={styles.confirmRouteLine} />
                  <View style={styles.confirmDestRow}>
                    <View
                      style={[
                        styles.routeDot,
                        { backgroundColor: "#E8500A", borderRadius: 3 },
                      ]}
                    />
                    <Text style={styles.confirmDestText} numberOfLines={1}>
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
                      {isScheduled
                        ? "Scheduled for later"
                        : "Schedule for later"}
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

                {/* Calendar */}
                {isScheduled && (
                  <View style={styles.calendarWrap}>
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
                        <Ionicons
                          name="chevron-back"
                          size={18}
                          color="#6B7280"
                        />
                      </TouchableOpacity>
                      <Text style={styles.calMonthLabel}>
                        {CAL_MONTHS[calMonth.getMonth()]}{" "}
                        {calMonth.getFullYear()}
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
                    <View style={styles.calWeekRow}>
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                        <Text key={d} style={styles.calWeekLabel}>
                          {d}
                        </Text>
                      ))}
                    </View>
                    <View style={styles.calGrid}>
                      {buildCalGrid().map((day, idx) => {
                        if (!day)
                          return (
                            <View key={`e-${idx}`} style={styles.calCell} />
                          );
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
                              setSelectedTime(null);
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
                                selectedTime === slot &&
                                  styles.timeChipSelected,
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

                {/* Payment */}
                <View style={styles.paymentSection}>
                  <Text style={styles.paymentLabel}>Payment</Text>
                  <View style={styles.paymentOptions}>
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
                        color={
                          selectedPayment === "cash" ? "#E8500A" : "#6B7280"
                        }
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

                {/* Fare */}
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

                {/* Buttons */}
                <View style={styles.confirmBtns}>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={resetBookingUI}
                  >
                    <Text style={styles.editBtnText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.bookBtn,
                      (bookingLoading || noDriversForImmediate) && {
                        opacity: 0.6,
                      },
                    ]}
                    onPress={confirmBooking}
                    disabled={bookingLoading || noDriversForImmediate}
                  >
                    {bookingLoading ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.bookBtnText}>
                        {noDriversForImmediate
                          ? "No drivers available"
                          : isScheduled
                            ? "Schedule ride"
                            : "Book ride"}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
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
              fetchDefaultCard();
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

      {reviewTarget && (
        <RideReviewModal
          visible={!!reviewTarget}
          rideId={reviewTarget.rideId}
          driverId={reviewTarget.driverId}
          driverName={reviewTarget.driverName}
          onDismiss={() => setReviewTarget(null)}
        />
      )}

      <DriverProfileSheet
        visible={driverProfileVisible}
        driverId={selectedDriverId}
        onClose={() => {
          setDriverProfileVisible(false);
          setSelectedDriverId(null);
        }}
      />
    </View>
  );
}

function decodePolyline(encoded: string): LatLng[] {
  const coords: LatLng[] = [];
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
    coords.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return coords;
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
  topActions: { flexDirection: "row", alignItems: "center", gap: 8 },
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
  driverMarkerMine: {
    backgroundColor: "#2A1A0E",
    borderRadius: 20,
    padding: 5,
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  driverMarkerText: { fontSize: 16 },
  pinWrap: { alignItems: "center" },
  pin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fff",
  },
  pinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 7,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },

  // ── Sheet layout ──
  // KAV sits at the bottom and grows upward — no fixed height so it
  // can size itself around its content and lift with the keyboard
  kavContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: SCREEN_HEIGHT * 0.78,
  },
  sheet: {
    backgroundColor: "#111827",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: Platform.OS === "ios" ? 36 : 24,
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

  predictionsList: { maxHeight: 240 },
  predictionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
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

  cardNudge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(232,80,10,0.07)",
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.2)",
    padding: 12,
    marginTop: 12,
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
  cardNudgeSub: { fontSize: 11, color: "#6B7280" },

  // Confirm
  confirmScroll: { flexGrow: 0 },
  confirmScrollContent: { paddingBottom: 4 },
  confirmHeader: { marginBottom: 14 },
  confirmTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 8,
  },
  confirmDestRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  confirmRouteLine: {
    width: 1.5,
    height: 14,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginLeft: 4.5,
    marginVertical: 3,
  },
  routeDot: { width: 10, height: 10, borderRadius: 5 },
  confirmDestText: {
    fontSize: 15,
    color: "#CBD5E1",
    flex: 1,
    fontWeight: "500",
  },

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
  scheduleToggleLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  scheduleToggleText: { fontSize: 14, color: "#6B7280", fontWeight: "500" },
  scheduleToggleTextActive: { color: "#A855F7" },
  togglePill: {
    width: 38,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#374151",
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  togglePillActive: { backgroundColor: "#A855F7" },
  toggleThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#9CA3AF",
    alignSelf: "flex-start",
  },
  toggleThumbActive: { backgroundColor: "#fff", alignSelf: "flex-end" },

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
  calMonthLabel: { fontSize: 14, fontWeight: "700", color: "#F1F5F9" },
  calWeekRow: { flexDirection: "row", marginBottom: 4 },
  calWeekLabel: {
    flex: 1,
    textAlign: "center",
    fontSize: 10,
    fontWeight: "600",
    color: "#4B5563",
    textTransform: "uppercase",
  },
  calGrid: { flexDirection: "row", flexWrap: "wrap" },
  calCell: {
    width: `${100 / 7}%` as any,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 100,
  },
  calCellSelected: { backgroundColor: "#A855F7" },
  calCellToday: { borderWidth: 1, borderColor: "rgba(168,85,247,0.5)" },
  calDayText: { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },
  calDayDisabled: { color: "#2D3748" },
  calDaySelected: { color: "#fff", fontWeight: "700" },
  calDayToday: { color: "#A855F7", fontWeight: "700" },
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
  timeScrollContent: { gap: 8, paddingRight: 4 },
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
  timeChipText: { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  timeChipTextSelected: { color: "#E9D5FF", fontWeight: "600" },
  schedSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  schedSummaryText: { fontSize: 13, color: "#A855F7", fontWeight: "600" },

  paymentSection: { marginBottom: 12 },
  paymentLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  paymentOptions: { gap: 8 },
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
  paymentOptionTitleSelected: { color: "#F1F5F9" },
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

  fareRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 16,
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
