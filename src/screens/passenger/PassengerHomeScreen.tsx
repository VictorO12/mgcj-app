import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  Keyboard,
  Dimensions,
  Animated,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import AnimatedMarker from "../../components/AnimatedMarker";
import CarMarker from "../../components/CarMarker";
import ScheduleDateTimePicker from "../../components/ScheduleDateTimePicker";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { GradientFill } from "../../components/GradientFill";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useAuth } from "../../hooks/AuthContext";
import { useActiveRide } from "../../hooks/useActiveRide";
import { supabase } from "../../lib/supabase";
import { invokeFunction } from "../../lib/invokeFunction";
import RideTrackingSheet from "../../components/RideTrackingSheet";
import ProfileMenu from "../../components/ProfileMenu";
import RideHistoryScreen from "../shared/RideHistoryScreen";
import ScheduledRidesScreen from "./ScheduledRidesScreen";
import PaymentMethodsScreen from "./PaymentMethodsScreen";
import Constants from "expo-constants";
import { useNotifications } from "../../hooks/useNotifications";
import RideReviewModal from "../../components/RideReviewModal";
import ProfileScreen from "./ProfileScreen";
import DiscountsScreen from "./DiscountsScreen";
import NotificationsScreen from "./NotificationsScreen";
import HelpSupportScreen from "./HelpSupportScreen";
import InboxScreen from "../shared/InboxScreen";
import { useInboxUnreadCount } from "../../hooks/useInboxUnreadCount";
import { useInterstitialQueue } from "../../hooks/useInterstitialQueue";
import InterstitialMessageCard from "../../components/InterstitialMessageCard";
import DriverProfileSheet from "../../components/DriverProfileSheet";
import { useTheme } from "../../theme/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Colors } from "../../theme/colors";

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
  structured_formatting?: {
    main_text?: string;
    secondary_text?: string;
  };
}
interface LatLng {
  latitude: number;
  longitude: number;
}
// A location is only ever "resolved" as a label+coords pair, set together from
// a Places prediction or the GPS fix. Free typing in the search box updates the
// display string only — it can never leave the stored address pointing at some
// older set of coordinates (the ride card said one place, the driver was routed
// to another).
interface ResolvedPlace {
  /** What gets stored as the ride's address — must describe `coords`. */
  label: string;
  /** What the passenger sees in the inputs (e.g. the friendly "My location"). */
  display: string;
  coords: LatLng;
  source: "gps" | "search";
}
// Places descriptions all end in ", Canada" (we restrict to country:ca), which
// tells a Nova Scotian driver nothing and pushes the reminder SMS into a
// second segment.
function stripCountry(description: string): string {
  return description.replace(/,\s*Canada\s*$/i, "");
}

// reverseGeocodeAsync splits the street line differently per platform: Android
// puts the civic number in `name` and the road in `street`, iOS often returns
// the whole thing in `name` and repeats the road in `street`. Joining blindly
// gives "9064, Commercial St" or "9064 Commercial St, Commercial St".
function streetLine(name?: string | null, street?: string | null): string {
  const n = name?.trim() ?? "";
  const s = street?.trim() ?? "";
  if (!n) return s;
  if (!s || n.includes(s)) return n;
  // The two can also disagree only in abbreviation ("9064 Commercial St" vs
  // "Commercial Street"), which a plain containment test misses. Treat a name
  // that carries a number and shares the road's first word as complete.
  const road = s.split(/\s+/)[0];
  if (/\d/.test(n) && road.length > 2 && n.includes(road)) return n;
  if (/^\d+[A-Za-z]?$/.test(n)) return `${n} ${s}`;
  return `${n}, ${s}`;
}

interface VehicleClass {
  id: string;
  name: string;
  capacity: number;
  surcharge_percent: number;
}
interface ActiveDriver {
  id: string;
  current_lat: number;
  current_lng: number;
  heading: number | null;
  last_seen_at: string | null;
  vehicle_make: string | null;
}

// Matches the 60s dispatch-side liveness threshold in
// supabase/functions/_shared/presence.ts.
const DRIVER_STALE_MS = 60_000;

const VALLEY_REGION = {
  latitude: 45.0773,
  longitude: -64.3601,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};
const BUSY_STATUSES = ["offered", "assigned", "driver_arriving", "in_progress"];

type MCIcon = React.ComponentProps<typeof MaterialCommunityIcons>["name"];
const CLASS_ICONS: Record<string, MCIcon> = {
  sedan:    "car-side",
  standard: "car-side",
  van:      "van-passenger",
  minivan:  "van-passenger",
  suv:      "car-estate",
  xl:       "car-estate",
  luxury:   "car-sports",
  truck:    "truck",
};

export default function PassengerHomeScreen() {
  const { profile, signOut } = useAuth();
  const { ride, eta, statusLabel, cancelledReason, clearCancelledReason } =
    useActiveRide(profile?.id);
  useNotifications();
  const { colors, resolvedTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, resolvedTheme, insets.bottom),
    [colors, resolvedTheme, insets.bottom],
  );

  const mapRef = useRef<MapView>(null);

  // Keyboard-aware bottom sheet. Expo SDK 54 forces Android edge-to-edge, so
  // the window no longer resizes under the keyboard and KeyboardAvoidingView
  // has nothing to shrink into — the sheet (position:absolute, bottom:0) would
  // sit behind the keyboard. Instead we lift it by the real keyboard height.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvt, (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Micro-interactions (RN Animated — no native module, works today).
  const bookScale = useRef(new Animated.Value(1)).current;
  const pressBookIn = () =>
    Animated.spring(bookScale, {
      toValue: 0.96,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start();
  const pressBookOut = () =>
    Animated.spring(bookScale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 20,
      bounciness: 8,
    }).start();
  // Gentle looping pulse on the "drivers available" dot.
  const driversPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(driversPulse, {
          toValue: 1,
          duration: 1100,
          useNativeDriver: true,
        }),
        Animated.timing(driversPulse, {
          toValue: 0,
          duration: 1100,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [driversPulse]);
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [pickupPlace, setPickupPlace] = useState<ResolvedPlace | null>(null);
  const [dropoffPlace, setDropoffPlace] = useState<ResolvedPlace | null>(null);
  // Display strings only — what's in the search box / input rows. The booking
  // insert never reads these; it reads the resolved places above.
  const [pickupText, setPickupText] = useState("My location");
  const [dropoffText, setDropoffText] = useState("");
  const [activeField, setActiveField] = useState<"pickup" | "dropoff" | null>(
    null,
  );
  const [predictions, setPredictions] = useState<PlacePrediction[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  // Has the passenger typed since opening the search box? Opening a field
  // pre-fills it with the resolved address and no predictions, which would
  // otherwise trip the "pick a location" hint before they've done anything.
  const [searchTouched, setSearchTouched] = useState(false);
  const [fareEstimate, setFareEstimate] = useState<number | null>(null);
  const [vehicleClasses, setVehicleClasses] = useState<VehicleClass[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [classFares, setClassFares] = useState<Record<string, number>>({});
  const [classAvailability, setClassAvailability] = useState<Record<string, number>>({});
  const [fareDiscountAmount, setFareDiscountAmount] = useState(0);
  const [fareDiscountType, setFareDiscountType] = useState<"student" | "code" | null>(
    null,
  );
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [discountCodeStatus, setDiscountCodeStatus] = useState<string | null>(
    null,
  );
  const [checkingDiscountCode, setCheckingDiscountCode] = useState(false);
  const [fareLoading, setFareLoading] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [sheet, setSheet] = useState<"search" | "confirm" | null>(null);
  const [activeDrivers, setActiveDrivers] = useState<ActiveDriver[]>([]);
  const activeDriversDebounce = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [menuVisible, setMenuVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [inboxVisible, setInboxVisible] = useState(false);
  const { unreadCount: inboxUnreadCount, refetch: refetchInboxUnread } = useInboxUnreadCount();

  // Tapping a "dispatch_message" push opens straight into the inbox rather than
  // just landing on the home screen — PassengerHomeScreen never unmounts (unlike
  // DriverApp's screen-swapping router), so no cross-component signal is needed.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data ?? {};
      if (data.type === "dispatch_message") setInboxVisible(true);
    });
    return () => sub.remove();
  }, []);
  const [scheduledVisible, setScheduledVisible] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [discountsVisible, setDiscountsVisible] = useState(false);
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
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

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
      // Commit the pickup before the reverse geocode, not after: that call
      // rejects in the wild (no network, no Play services) and a passenger
      // with no resolved pickup can never reach the confirm sheet. The label
      // falls back to the coordinates in words so the driver's ride card
      // always carries something locatable — never the "My location" alias.
      setPickupPlace({
        label: `Current location (${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)})`,
        display: "My location",
        coords,
        source: "gps",
      });
      setPickupText("My location");
      mapRef.current?.animateToRegion(
        { ...coords, latitudeDelta: 0.08, longitudeDelta: 0.08 },
        800,
      );
      try {
        const [place] = await Location.reverseGeocodeAsync(coords);
        // Store the full address for the driver's ride card; the input row
        // shows the short form, same split as a searched place.
        const display = place ? streetLine(place.name, place.street) : "";
        const label = place
          ? [display, place.city, place.region].filter(Boolean).join(", ")
          : "";
        if (label) {
          setPickupPlace({
            label,
            display: display || label,
            coords,
            source: "gps",
          });
          setPickupText(display || label);
        }
      } catch {
        // Keep the coordinate-labelled pickup committed above.
      }
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
      // 6s, not 15s: the passenger's RLS policy on `drivers` is
      // USING (is_active = true ...), so when a driver goes offline the UPDATE
      // fails the policy on the new row and Realtime never delivers it. The
      // subscription below only ever catches location/status changes on
      // still-online drivers — this poll is the only thing that can retire a
      // car that went offline.
      const interval = setInterval(fetchActiveDrivers, 6000);
      return () => clearInterval(interval);
    }
    setActiveDrivers([]);
  }, [!!ride]);

  // Realtime: refresh the "drivers online" count immediately on relevant
  // changes instead of waiting for the 15s poll above (which stays as a
  // fallback). Debounced since a burst of ride updates shouldn't trigger
  // a refetch per row.
  useEffect(() => {
    if (ride) return;
    const channel = supabase
      .channel("active-drivers")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "drivers" },
        () => {
          if (activeDriversDebounce.current)
            clearTimeout(activeDriversDebounce.current);
          activeDriversDebounce.current = setTimeout(fetchActiveDrivers, 400);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides" },
        () => {
          if (activeDriversDebounce.current)
            clearTimeout(activeDriversDebounce.current);
          activeDriversDebounce.current = setTimeout(fetchActiveDrivers, 400);
        },
      )
      .subscribe();
    return () => {
      if (activeDriversDebounce.current)
        clearTimeout(activeDriversDebounce.current);
      supabase.removeChannel(channel);
    };
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
      .select("id, current_lat, current_lng, heading, last_seen_at, vehicle_make")
      .eq("is_active", true)
      .not("current_lat", "is", null);
    if (!drivers || drivers.length === 0) {
      setActiveDrivers([]);
      return;
    }
    // `is_active` is a manual toggle, so a driver who force-quits the app stays
    // "online" with a frozen position until the 5-min reaper. Mirror the
    // backend's 60s liveness filter (functions/_shared/presence.ts) so a
    // phantom isn't shown a car on the map — and, as there, a NULL heartbeat
    // counts as live so drivers on builds that predate it stay visible.
    const liveCutoff = Date.now() - DRIVER_STALE_MS;
    const live = drivers.filter(
      (d) => !d.last_seen_at || new Date(d.last_seen_at).getTime() >= liveCutoff,
    );
    if (live.length === 0) {
      setActiveDrivers([]);
      return;
    }
    const driverIds = live.map((d) => d.id);
    const { data: busyRides } = await supabase
      .from("rides")
      .select("driver_id")
      .in("status", BUSY_STATUSES)
      .in("driver_id", driverIds);
    const busyDriverIds = new Set((busyRides ?? []).map((r) => r.driver_id));
    setActiveDrivers(
      live.filter(
        (d) => !busyDriverIds.has(d.id) && d.current_lat && d.current_lng,
      ) as ActiveDriver[],
    );
  }

  // Typed-but-unresolved text is only ever allowed to live inside the open
  // search box. Any move away from it (closing, switching fields) snaps both
  // inputs back to the addresses actually backed by coordinates.
  function snapTextsToResolved() {
    setPickupText(pickupPlace?.display ?? "My location");
    setDropoffText(dropoffPlace?.display ?? "");
    setSearchTouched(false);
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
      // Keep the whole description as the stored address — the civic number
      // is in the same response and the driver needs it. The input row still
      // shows just the venue/street so the sheet stays readable.
      const place: ResolvedPlace = {
        label: stripCountry(prediction.description),
        display:
          prediction.structured_formatting?.main_text ||
          prediction.description.split(",")[0],
        coords,
        source: "search",
      };
      if (activeField === "pickup") {
        setPickupPlace(place);
        setPickupText(place.display);
      } else {
        setDropoffPlace(place);
        setDropoffText(place.display);
      }
      setPredictions([]);
      setActiveField(null);
      setSearchTouched(false);
      const pickup = activeField === "pickup" ? place : pickupPlace;
      const dropoff = activeField === "dropoff" ? place : dropoffPlace;
      if (pickup && dropoff) {
        // The field we didn't just resolve may still be showing abandoned
        // free text from an earlier search — snap it back to its real label
        // so the confirm sheet can't show an address we aren't booking.
        if (activeField === "pickup") setDropoffText(dropoff.display);
        else setPickupText(pickup.display);
        setSheet("confirm");
        getFareEstimate(pickup.coords, dropoff.coords);
        mapRef.current?.fitToCoordinates([pickup.coords, dropoff.coords], {
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
      const [directionsRes, pricingRes, classesRes, onlineDriversRes, busyRidesRes] = await Promise.all([
        fetch(
          `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.latitude},${pickup.longitude}&destination=${dropoff.latitude},${dropoff.longitude}&key=${MAPS_KEY}`,
        ),
        profile?.company_id
          ? supabase.from("companies").select("base_fare, rate_per_km").eq("id", profile.company_id).maybeSingle()
          : Promise.resolve({ data: null }),
        profile?.company_id
          ? supabase.from("vehicle_classes").select("id, name, capacity, surcharge_percent").eq("company_id", profile.company_id).eq("is_active", true).order("display_order")
          : Promise.resolve({ data: [] }),
        supabase.from("drivers").select("id, vehicle_class_id").eq("is_active", true).not("current_lat", "is", null),
        supabase.from("rides").select("driver_id").in("status", BUSY_STATUSES).not("driver_id", "is", null),
      ]);
      const metres = (await directionsRes.json()).routes?.[0]?.legs?.[0]?.distance?.value ?? 0;
      const pricing = (pricingRes as any).data;
      const baseFareRate = pricing?.base_fare ?? 4;
      const ratePerKm = pricing?.rate_per_km ?? 1.8;
      const baseFare = Math.round((baseFareRate + (metres / 1000) * ratePerKm) * 100) / 100;

      const classes: VehicleClass[] = (classesRes as any).data ?? [];
      setVehicleClasses(classes);

      // Compute a fare per class (surcharge applied to whole fare)
      const fares: Record<string, number> = {};
      for (const vc of classes) {
        fares[vc.id] = Math.round(baseFare * (1 + vc.surcharge_percent / 100) * 100) / 100;
      }
      setClassFares(fares);

      // Compute available driver count per class
      const busyIds = new Set(((busyRidesRes as any).data ?? []).map((r: any) => r.driver_id));
      const avail: Record<string, number> = {};
      for (const d of ((onlineDriversRes as any).data ?? [])) {
        if (!busyIds.has(d.id) && d.vehicle_class_id) {
          avail[d.vehicle_class_id] = (avail[d.vehicle_class_id] ?? 0) + 1;
        }
      }
      setClassAvailability(avail);

      // Auto-select: prefer first class that has available drivers; fall back to first class
      const firstAvailable = classes.find(c => (avail[c.id] ?? 0) > 0) ?? classes[0] ?? null;
      const autoId = firstAvailable?.id ?? null;
      setSelectedClassId(autoId);
      const activeFare = autoId ? (fares[autoId] ?? baseFare) : baseFare;
      setFareEstimate(activeFare);
      const discount = await getDiscount(activeFare);
      setFareDiscountAmount(discount.discountAmount);
      setFareDiscountType(discount.discountType);
    } catch (e) {
      console.error(e);
    }
    setFareLoading(false);
  }

  async function selectClass(classId: string) {
    setSelectedClassId(classId);
    const fare = classFares[classId];
    if (fare == null) return;
    setFareEstimate(fare);
    const discount = await getDiscount(fare, discountCodeInput || undefined);
    setFareDiscountAmount(discount.discountAmount);
    setFareDiscountType(discount.discountType);
  }

  async function getDiscount(fare: number, code?: string) {
    const fallback = {
      discountedFare: fare,
      discountAmount: 0,
      discountType: null as "student" | "code" | null,
      codeId: null as string | null,
      codeStatus: "none" as string,
    };
    if (!profile?.company_id) return fallback;
    try {
      const { data, error } = await supabase
        .rpc("compute_discount_for_booking", {
          p_user_id: profile.id,
          p_company_id: profile.company_id,
          p_fare: fare,
          p_code: code?.trim() || null,
        })
        .maybeSingle();
      if (error || !data) return fallback;
      const result = data as {
        discounted_fare: number;
        discount_amount: number;
        discount_type: "student" | "code" | null;
        code_id: string | null;
        code_status: string;
      };
      return {
        discountedFare: result.discounted_fare ?? fare,
        discountAmount: result.discount_amount ?? 0,
        discountType: result.discount_type ?? null,
        codeId: result.code_id ?? null,
        codeStatus: result.code_status ?? "none",
      };
    } catch (e) {
      console.error("Discount check failed:", e);
      return fallback;
    }
  }

  const DISCOUNT_CODE_ERRORS: Record<string, string> = {
    not_found: "Code not found.",
    inactive: "This code is no longer active.",
    not_started: "This code isn't active yet.",
    expired: "This code has expired.",
    maxed: "This code has reached its usage limit.",
    already_used: "You've already used this code.",
  };

  async function applyDiscountCode() {
    if (!fareEstimate) return;
    if (!discountCodeInput.trim()) {
      setDiscountCodeStatus(null);
      setFareDiscountAmount(0);
      setFareDiscountType(null);
      return;
    }
    setCheckingDiscountCode(true);
    const discount = await getDiscount(fareEstimate, discountCodeInput);
    setCheckingDiscountCode(false);
    if (discount.codeStatus === "ok") {
      setFareDiscountAmount(discount.discountAmount);
      setFareDiscountType(discount.discountType);
      setDiscountCodeStatus("ok");
    } else {
      setFareDiscountAmount(0);
      setFareDiscountType(null);
      setDiscountCodeStatus(
        DISCOUNT_CODE_ERRORS[discount.codeStatus] ?? "Couldn't apply that code.",
      );
    }
  }

  async function confirmBooking() {
    if (!pickupPlace || !dropoffPlace || !profile) {
      Alert.alert(
        "Missing info",
        "Please choose both a pickup and a dropoff from the suggestions.",
      );
      return;
    }
    // Backstop: the displayed address must be the one we're about to book.
    // Every path out of the search box already snaps the text back to the
    // resolved label, so this should be unreachable — if it ever fires, we'd
    // rather stop than route a driver somewhere the passenger didn't ask for.
    if (
      pickupText.trim() !== pickupPlace.display.trim() ||
      dropoffText.trim() !== dropoffPlace.display.trim()
    ) {
      Alert.alert(
        "Confirm your addresses",
        "Please pick your pickup and dropoff from the suggestion list so we send the driver to the right place.",
      );
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
    // Pre-flight: for immediate rides, verify a driver of the selected class is
    // still online — catches the race between sheet open and confirm tap.
    if (!isScheduled && selectedClassId) {
      const { count } = await supabase
        .from("drivers")
        .select("*", { count: "exact", head: true })
        .eq("vehicle_class_id", selectedClassId)
        .eq("is_active", true)
        .not("current_lat", "is", null);

      if (!count || count === 0) {
        const className = vehicleClasses.find(c => c.id === selectedClassId)?.name;
        setClassAvailability(prev => ({ ...prev, [selectedClassId]: 0 }));
        Alert.alert(
          "No drivers available",
          className
            ? `No ${className} drivers are online right now. Choose another vehicle type or try again shortly.`
            : "No drivers of this type are online right now. Please try again shortly.",
        );
        return;
      }
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

        // Stripe card holds only last ~7 days, but rides can be scheduled up
        // to 60 days out — so for scheduled rides we defer creating the
        // PaymentIntent until shortly before pickup (scheduled-lifecycle
        // cron) instead of authorizing the card at booking time.
        let paymentIntentId: string | null = null;
        let discountedFare = fareEstimate;
        let discountAmount = 0;
        let discountType: "student" | "code" | null = null;
        let discountCodeId: string | null = null;
        if (!scheduledAt) {
          const {
            data: intentData,
            error: intentError,
            authExpired,
          } = await invokeFunction(
            "create-payment-intent",
            {
              pickup_lat: pickupPlace.coords.latitude,
              pickup_lng: pickupPlace.coords.longitude,
              dropoff_lat: dropoffPlace.coords.latitude,
              dropoff_lng: dropoffPlace.coords.longitude,
              discount_code: discountCodeInput.trim() || null,
            },
            "Could not process payment. Please try a different card or pay with cash.",
          );
          if (intentError) {
            setBookingLoading(false);
            // A 401 here is an auth problem wearing a payment problem's
            // clothes: this function calls getUser(), so a revoked session
            // fails it while every PostgREST read on screen keeps working.
            // Telling the passenger to try another card would send them
            // round a loop no card can win.
            Alert.alert(
              authExpired ? "Please sign in again" : "Payment failed",
              authExpired
                ? "Your session expired on this device. Sign out and back in, then book again."
                : (intentData?.message ?? intentError),
            );
            return;
          }
          paymentIntentId = intentData.payment_intent_id;
          discountedFare = intentData.discounted_fare ?? fareEstimate;
          discountAmount = intentData.discount_amount ?? 0;
          discountType = intentData.discount_type ?? null;
          discountCodeId = intentData.discount_code_id ?? null;
        } else {
          // Scheduled rides defer PaymentIntent creation, so compute the
          // discount client-side now to show/store the correct fare.
          const discount = await getDiscount(fareEstimate, discountCodeInput);
          discountedFare = discount.discountedFare;
          discountAmount = discount.discountAmount;
          discountType = discount.discountType;
          discountCodeId = discount.codeId;
        }

        const { error: rideError } = await supabase.from("rides").insert({
          passenger_id: profile.id,
          company_id: profile.company_id,
          vehicle_class_id: selectedClassId,
          status: scheduledAt ? "scheduled" : "pending",
          pickup_address: pickupPlace.label,
          pickup_lat: pickupPlace.coords.latitude,
          pickup_lng: pickupPlace.coords.longitude,
          dropoff_address: dropoffPlace.label,
          dropoff_lat: dropoffPlace.coords.latitude,
          dropoff_lng: dropoffPlace.coords.longitude,
          fare_estimate: discountedFare,
          pre_discount_fare: fareEstimate,
          discount_amount: discountAmount,
          discount_type: discountType,
          discount_code_id: discountCodeId,
          payment_method: "card",
          payment_method_id: paymentCard?.id ?? null,
          stripe_payment_intent_id: paymentIntentId,
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

    const cashDiscount = await getDiscount(fareEstimate ?? 0, discountCodeInput);
    // Cash fares round up to the nearest dollar so passengers don't need exact change.
    const roundedCashFare = Math.ceil(cashDiscount.discountedFare);

    const { error: rideError } = await supabase.from("rides").insert({
      passenger_id: profile.id,
      company_id: profile.company_id,
      vehicle_class_id: selectedClassId,
      status: scheduledAt ? "scheduled" : "pending",
      pickup_address: pickupPlace.label,
      pickup_lat: pickupPlace.coords.latitude,
      pickup_lng: pickupPlace.coords.longitude,
      dropoff_address: dropoffPlace.label,
      dropoff_lat: dropoffPlace.coords.latitude,
      dropoff_lng: dropoffPlace.coords.longitude,
      fare_estimate: roundedCashFare,
      pre_discount_fare: fareEstimate,
      discount_amount: cashDiscount.discountAmount,
      discount_type: cashDiscount.discountType,
      discount_code_id: cashDiscount.codeId,
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
    // settle-ride releases the card hold before ending the ride — see the
    // note in ScheduledRidesScreen.cancelRide.
    const { error } = await invokeFunction("settle-ride", {
      ride_id: ride.id,
      action: "cancel",
    });
    if (error) {
      Alert.alert("Couldn't cancel", error);
    }
  }

  function resetBookingUI() {
    setDropoffText("");
    setDropoffPlace(null);
    // Pickup keeps its resolved place (usually the GPS fix) for the next
    // booking, so snap its text back in case a search was abandoned.
    setPickupText(pickupPlace?.display ?? "My location");
    setFareEstimate(null);
    setFareDiscountAmount(0);
    setFareDiscountType(null);
    setDiscountCodeInput("");
    setDiscountCodeStatus(null);
    setSheet(null);
    setPredictions([]);
    setActiveField(null);
    setSearchTouched(false);
    setIsScheduled(false);
    setScheduledDate(null);
    if (userLocation)
      mapRef.current?.animateToRegion(
        { ...userLocation, latitudeDelta: 0.08, longitudeDelta: 0.08 },
        600,
      );
  }

  const hasActiveRide = !!ride;
  const searchQuery = activeField === "dropoff" ? dropoffText : pickupText;
  const searchHint =
    predictions.length > 0
      ? `Tap a suggestion to set your ${activeField === "dropoff" ? "destination" : "pickup"}.`
      : searchQuery.trim().length < 3
        ? "Keep typing to see suggestions."
        : "No matches. Pick the closest spot you can find, then tell your driver the details when they call.";
  const interstitialGateOpen =
    !hasActiveRide &&
    sheet === null &&
    !reviewTarget &&
    !menuVisible &&
    !historyVisible &&
    !inboxVisible &&
    !scheduledVisible &&
    !paymentVisible &&
    !discountsVisible &&
    !profileVisible &&
    !notificationsVisible &&
    !helpVisible &&
    !driverProfileVisible;
  const { current: interstitialMessage, dismiss: dismissInterstitial } =
    useInterstitialQueue(interstitialGateOpen);
  const noDriversForImmediate = !isScheduled && (
    vehicleClasses.length > 1
      ? selectedClassId != null && (classAvailability[selectedClassId] ?? 0) === 0
      : activeDrivers.length === 0
  );
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
        customMapStyle={resolvedTheme === "dark" ? darkMapStyle : []}
      >
        {!hasActiveRide &&
          activeDrivers.map((d) => (
            <AnimatedMarker
              key={d.id}
              coordinate={{ latitude: d.current_lat, longitude: d.current_lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              snapMeters={1000}
              heading={d.heading}
              onPress={() => openDriverProfile(d.id)}
            >
              <CarMarker
                size={38}
                body={colors.carBody}
                glass={colors.carGlass}
                stroke={colors.carStroke}
                opacity={0.92}
              />
            </AnimatedMarker>
          ))}
        {/* The GPS pickup is already shown by the blue user-location dot, so
            only pin a pickup the passenger searched for. */}
        {!hasActiveRide && pickupPlace?.source === "search" && (
          <Marker
            coordinate={pickupPlace.coords}
            pinColor={colors.accentBlue}
            title="Pickup"
          />
        )}
        {!hasActiveRide && dropoffPlace && (
          <Marker
            coordinate={dropoffPlace.coords}
            pinColor={colors.accentOrange}
            title="Drop-off"
          />
        )}
        {hasActiveRide && driverCoords && (
          <AnimatedMarker
            coordinate={driverCoords}
            anchor={{ x: 0.5, y: 0.5 }}
            snapMeters={1000}
            heading={ride?.driver?.heading ?? null}
          >
            {/* Your driver: brand orange and a size up, so it reads instantly
                against the neutral ambient cars. */}
            <CarMarker
              size={46}
              body={colors.accentOrange}
              glass={colors.carGlass}
              stroke={colors.carStroke}
            />
          </AnimatedMarker>
        )}
        {hasActiveRide && !isInProgress && pickupPin && (
          <Marker coordinate={pickupPin} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.pinWrap}>
              <View style={[styles.pin, { backgroundColor: colors.accentBlue }]}>
                <Ionicons name="person" size={12} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: colors.accentBlue }]} />
            </View>
          </Marker>
        )}
        {hasActiveRide && isInProgress && dropoffPin && (
          <Marker coordinate={dropoffPin} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.pinWrap}>
              <View style={[styles.pin, { backgroundColor: colors.accentOrange }]}>
                <Ionicons name="flag" size={12} color="#fff" />
              </View>
              <View style={[styles.pinTail, { borderTopColor: colors.accentOrange }]} />
            </View>
          </Marker>
        )}
        {hasActiveRide && rideRouteCoords.length > 0 && (
          <Polyline
            coordinates={rideRouteCoords}
            strokeColor={isInProgress ? colors.accentOrange : colors.accentBlue}
            strokeWidth={3}
          />
        )}
      </MapView>

      {/* Top bar */}
      <View style={styles.headerWrap} pointerEvents="box-none">
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
                <Ionicons name="calendar-outline" size={20} color={colors.accentPurple} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.inboxBtn}
              onPress={() => setInboxVisible(true)}
            >
              <Ionicons name="mail-outline" size={19} color={colors.accentBlue} />
              {inboxUnreadCount > 0 && (
                <View style={styles.inboxBadge}>
                  <Text style={styles.inboxBadgeText}>
                    {inboxUnreadCount > 9 ? "9+" : inboxUnreadCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
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
            <Animated.View
              style={[
                styles.driversPillDot,
                {
                  transform: [
                    {
                      scale: driversPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 1.5],
                      }),
                    },
                  ],
                  opacity: driversPulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0.5],
                  }),
                },
              ]}
            />
            <Text style={styles.driversPillText}>
              {activeDrivers.length} driver{activeDrivers.length > 1 ? "s" : ""}{" "}
              available
            </Text>
          </View>
        )}
      </View>

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
          <Ionicons name="locate" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      )}

      {/* ── BOTTOM SHEET ── */}
      {!hasActiveRide && (
        <View style={[styles.kavContainer, { bottom: keyboardHeight }]}>
          <View
            style={[
              styles.sheet,
              sheet === "confirm" && styles.sheetConfirm,
              // Keyboard covers the nav bar, so drop the extra bottom padding
              // and just leave a small gap above the keyboard.
              keyboardHeight > 0 && styles.sheetKeyboardOpen,
            ]}
          >
            <View style={styles.grabber} />
            {/* Input card — always visible except in confirm */}
            {sheet !== "confirm" && (
              <View style={styles.inputsCard}>
                <TouchableOpacity
                  style={styles.inputRow}
                  onPress={() => {
                    snapTextsToResolved();
                    setActiveField("pickup");
                    setSheet("search");
                  }}
                  activeOpacity={0.8}
                >
                  <View
                    style={[styles.inputDot, { backgroundColor: colors.accentBlue }]}
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
                    snapTextsToResolved();
                    setActiveField("dropoff");
                    setSheet("search");
                  }}
                  activeOpacity={0.8}
                >
                  <View
                    style={[
                      styles.inputDot,
                      { backgroundColor: colors.accentOrange, borderRadius: 3 },
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
                  color={colors.textSecondary}
                  style={{ marginRight: 8 }}
                />
                <TextInput
                  style={styles.searchInput}
                  placeholder={
                    activeField === "pickup"
                      ? "Search pickup..."
                      : "Search destination..."
                  }
                  placeholderTextColor={colors.textSecondary}
                  autoFocus
                  onChangeText={(t) => {
                    // Display text only — coordinates come from a tapped
                    // prediction, never from what's typed here.
                    activeField === "dropoff"
                      ? setDropoffText(t)
                      : setPickupText(t);
                    setSearchTouched(true);
                    searchPlaces(t);
                  }}
                  value={activeField === "dropoff" ? dropoffText : pickupText}
                />
                {searchLoading && (
                  <ActivityIndicator size="small" color={colors.accentOrange} />
                )}
                <TouchableOpacity
                  onPress={() => {
                    snapTextsToResolved();
                    setSheet(null);
                    setActiveField(null);
                    setPredictions([]);
                  }}
                >
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            )}

            {/* Search hint. A location only counts once it's picked from the
                list — typed text is thrown away on close — so say that out
                loud instead of letting the input silently snap back. */}
            {sheet === "search" && searchTouched && !searchLoading && (
              <Text style={styles.searchHint}>{searchHint}</Text>
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
                      color={colors.textSecondary}
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
                        setSearchTouched(true);
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
                      <Ionicons name="card-outline" size={18} color={colors.accentOrange} />
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
                      <Ionicons name="close" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                )}
              </ScrollView>
            )}

            {/* ── CONFIRM SHEET ── */}
            {sheet === "confirm" && (
              <>
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
                      style={[styles.routeDot, { backgroundColor: colors.accentBlue }]}
                    />
                    {/* Full address, not the short input-row form: this is the
                        last place a passenger can catch that they picked the
                        Sobeys in Truro. Two lines so the civic number shows. */}
                    <Text style={styles.confirmDestText} numberOfLines={2}>
                      {pickupPlace?.label ?? pickupText}
                    </Text>
                  </View>
                  <View style={styles.confirmRouteLine} />
                  <View style={styles.confirmDestRow}>
                    <View
                      style={[
                        styles.routeDot,
                        { backgroundColor: colors.accentOrange, borderRadius: 3 },
                      ]}
                    />
                    <Text style={styles.confirmDestText} numberOfLines={2}>
                      {dropoffPlace?.label ?? dropoffText}
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
                    if (!next) setScheduledDate(null);
                  }}
                  activeOpacity={0.8}
                >
                  <View style={styles.scheduleToggleLeft}>
                    <Ionicons
                      name={isScheduled ? "calendar" : "calendar-outline"}
                      size={16}
                      color={isScheduled ? colors.accentPurple : colors.textSecondary}
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
                  <ScheduleDateTimePicker
                    value={scheduledDate}
                    onChange={setScheduledDate}
                  />
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
                            selectedPayment === "card" ? colors.accentOrange : colors.textSecondary
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
                            color={colors.accentOrange}
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
                          color={colors.accentOrange}
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
                          selectedPayment === "cash" ? colors.accentOrange : colors.textSecondary
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
                          color={colors.accentOrange}
                        />
                      )}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Vehicle class picker — only shown when company has multiple classes */}
                {vehicleClasses.length > 1 && (
                  <View style={styles.classSection}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.classScroll}
                    >
                      {vehicleClasses.map((vc) => {
                        const fare = classFares[vc.id];
                        const selected = selectedClassId === vc.id;
                        const icon: MCIcon = CLASS_ICONS[vc.name.toLowerCase()] ?? "car-side";
                        const driverCount = classAvailability[vc.id] ?? 0;
                        const unavailable = !isScheduled && driverCount === 0;
                        return (
                          <TouchableOpacity
                            key={vc.id}
                            style={[
                              styles.classCard,
                              selected && styles.classCardSelected,
                              unavailable && styles.classCardUnavailable,
                            ]}
                            onPress={() => !unavailable && selectClass(vc.id)}
                            activeOpacity={unavailable ? 1 : 0.75}
                          >
                            {selected && !unavailable && (
                              <View style={styles.classCheckmark}>
                                <Ionicons name="checkmark-circle" size={14} color={colors.accentOrange} />
                              </View>
                            )}
                            <MaterialCommunityIcons
                              name={icon}
                              size={28}
                              color={unavailable ? colors.textMuted : selected ? colors.accentOrange : colors.textSecondary}
                              style={styles.classIcon}
                            />
                            <Text style={[styles.classCardName, selected && !unavailable && styles.classCardNameSelected, unavailable && styles.classCardNameUnavailable]}>
                              {vc.name}
                            </Text>
                            <Text style={[styles.classCardSeats, selected && !unavailable && styles.classCardSeatsSelected]}>
                              {vc.capacity} seats
                            </Text>
                            {fare != null && (
                              <Text style={[styles.classCardFare, selected && !unavailable && styles.classCardFareSelected, unavailable && styles.classCardFareUnavailable]}>
                                {unavailable
                                  ? "Unavailable"
                                  : `$${(selectedPayment === "cash" ? Math.ceil(fare) : fare).toFixed(2)}`}
                              </Text>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                )}

                {/* Discount code — hidden once a verified student discount
                    is already auto-applied, since it always wins over a code */}
                {fareDiscountType !== "student" && (
                  <View style={styles.discountCodeRow}>
                    <TextInput
                      style={styles.discountCodeInput}
                      value={discountCodeInput}
                      onChangeText={(t) => {
                        setDiscountCodeInput(t);
                        setDiscountCodeStatus(null);
                      }}
                      placeholder="Discount code (optional)"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      returnKeyType="done"
                      onSubmitEditing={applyDiscountCode}
                    />
                    <TouchableOpacity
                      style={styles.discountCodeBtn}
                      onPress={applyDiscountCode}
                      disabled={checkingDiscountCode}
                      activeOpacity={0.8}
                    >
                      {checkingDiscountCode ? (
                        <ActivityIndicator size="small" color={colors.accentOrange} />
                      ) : (
                        <Text style={styles.discountCodeBtnText}>Apply</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )}
                {discountCodeStatus && discountCodeStatus !== "ok" && (
                  <Text style={styles.discountCodeError}>{discountCodeStatus}</Text>
                )}
                {discountCodeStatus === "ok" && (
                  <Text style={styles.discountCodeSuccess}>Code applied</Text>
                )}

                {/* Fare */}
                <View style={styles.fareRow}>
                  <View>
                    <Text style={styles.fareLabel}>Estimated fare</Text>
                    <Text style={styles.fareNote}>
                      {selectedPayment === "card" ? "Card · " : "Cash · "}
                      Subject to final distance
                    </Text>
                    {isScheduled && selectedPayment === "card" && (
                      <Text style={styles.fareNote}>
                        Final fare confirmed near pickup
                      </Text>
                    )}
                  </View>
                  {fareLoading ? (
                    <ActivityIndicator color={colors.accentOrange} />
                  ) : fareDiscountAmount > 0 && fareEstimate != null ? (
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.fareStrikethrough}>
                        ${fareEstimate.toFixed(2)}
                      </Text>
                      <Text style={styles.fareAmount}>
                        $
                        {selectedPayment === "cash"
                          ? Math.ceil(fareEstimate - fareDiscountAmount).toFixed(2)
                          : (fareEstimate - fareDiscountAmount).toFixed(2)}
                      </Text>
                      <Text style={styles.fareDiscountBadge}>
                        {fareDiscountType === "student"
                          ? "Student discount"
                          : "Discount code applied"}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.fareAmount}>
                      $
                      {fareEstimate == null
                        ? "--"
                        : (selectedPayment === "cash"
                            ? Math.ceil(fareEstimate)
                            : fareEstimate
                          ).toFixed(2)}
                    </Text>
                  )}
                </View>
              </ScrollView>

              {/* Buttons — kept outside the ScrollView so they're always
                  visible without needing to scroll */}
              <View style={styles.confirmBtns}>
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={resetBookingUI}
                >
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
                <Animated.View
                  style={[
                    styles.bookBtnWrap,
                    { transform: [{ scale: bookScale }] },
                  ]}
                >
                <TouchableOpacity
                  style={[
                    styles.bookBtn,
                    (bookingLoading || noDriversForImmediate) && {
                      opacity: 0.6,
                    },
                  ]}
                  activeOpacity={0.9}
                  onPressIn={pressBookIn}
                  onPressOut={pressBookOut}
                  onPress={confirmBooking}
                  disabled={bookingLoading || noDriversForImmediate}
                >
                  {!noDriversForImmediate && (
                    <GradientFill
                      colors={["#F97316", "#E8500A", "#C2410C"]}
                      style={[StyleSheet.absoluteFill, styles.bookBtnGradient]}
                    />
                  )}
                  {bookingLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <View style={styles.bookBtnInner}>
                      <Text style={styles.bookBtnText}>
                        {noDriversForImmediate
                          ? "No drivers available"
                          : isScheduled
                            ? "Schedule ride"
                            : "Book ride"}
                      </Text>
                      {!noDriversForImmediate && (
                        <Ionicons
                          name={isScheduled ? "calendar" : "arrow-forward"}
                          size={17}
                          color="#fff"
                        />
                      )}
                    </View>
                  )}
                </TouchableOpacity>
                </Animated.View>
              </View>
              </>
            )}
          </View>
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
      {discountsVisible && (
        <View style={StyleSheet.absoluteFill}>
          <DiscountsScreen onClose={() => setDiscountsVisible(false)} />
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
        onOpenDiscounts={() => setDiscountsVisible(true)}
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

      {interstitialMessage && (
        <InterstitialMessageCard
          message={interstitialMessage}
          onDismiss={() => {
            dismissInterstitial();
            refetchInboxUnread();
          }}
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

const makeStyles = (colors: Colors, resolvedTheme: "light" | "dark", bottomInset: number = 0) => {
  const isDark = resolvedTheme === "dark";
  // Soft elevation presets. Dark surfaces swallow drop shadows, so there we
  // lean on a tighter, higher-opacity shadow purely to lift floating controls
  // off the map; light mode gets a wider, softer ambient shadow.
  const floatShadow = {
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.45 : 0.14,
    shadowRadius: 12,
    elevation: 6,
  };
  const sheetShadow = {
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: isDark ? 0.5 : 0.12,
    shadowRadius: 20,
    elevation: 16,
  };
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    map: { flex: 1 },
    headerWrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingHorizontal: 20,
      paddingBottom: 12,
      backgroundColor: colors.backgroundOverlay,
    },
    topName: {
      fontSize: 22,
      fontWeight: "800",
      color: colors.textPrimary,
      letterSpacing: -0.4,
    },
    topSub: { fontSize: 13, color: colors.textSecondary, marginTop: 3 },
    topActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    topAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 2,
      borderColor: colors.accentOrange,
      ...floatShadow,
    },
    topAvatarFallback: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.accentOrange,
      ...floatShadow,
    },
    topAvatarInitials: { fontSize: 13, fontWeight: "700", color: colors.avatarText },
    calendarBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: isDark ? "rgba(168,85,247,0.16)" : colors.surface,
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.3)",
      alignItems: "center",
      justifyContent: "center",
      ...floatShadow,
    },
    avatarBtn: { padding: 4 },
    inboxBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: isDark ? "rgba(74,158,255,0.16)" : colors.surface,
      borderWidth: 0.5,
      borderColor: "rgba(74,158,255,0.3)",
      alignItems: "center",
      justifyContent: "center",
      ...floatShadow,
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
    driversPill: {
      alignSelf: "flex-start",
      marginLeft: 20,
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: colors.surfaceOverlay,
      borderRadius: 20,
      paddingVertical: 7,
      paddingHorizontal: 13,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      ...floatShadow,
    },
    driversPillDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.accentGreen,
    },
    driversPillText: { fontSize: 12, color: colors.textTertiary, fontWeight: "500" },
    recenterBtn: {
      position: "absolute",
      right: 16,
      bottom: 320,
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
      ...floatShadow,
    },
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
      backgroundColor: colors.background,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderTopWidth: 0.5,
      borderColor: colors.borderStrong,
      paddingHorizontal: 20,
      paddingTop: 10,
      // Lift bottom content clear of the home indicator / Android gesture &
      // 3-button nav bars (edge-to-edge is mandatory in Expo SDK 54).
      paddingBottom: (Platform.OS === "ios" ? 36 : 24) + bottomInset,
      ...sheetShadow,
    },
    // Applied only to the confirm step: caps the sheet's own box at the
    // same height the KAV wrapper allows, so the ScrollView (flexShrink)
    // is forced to give up space to the button row below it instead of
    // pushing it past the screen edge.
    sheetConfirm: {
      maxHeight: SCREEN_HEIGHT * 0.78,
      flexShrink: 1,
    },
    // When the keyboard is up it sits over the nav bar, so the big bottom
    // inset would only push content needlessly high — collapse to a small gap.
    sheetKeyboardOpen: {
      paddingBottom: 12,
    },
    grabber: {
      alignSelf: "center",
      width: 40,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.borderStrong,
      marginBottom: 12,
    },

    inputsCard: {
      backgroundColor: colors.surface,
      borderRadius: 18,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      marginBottom: 14,
      overflow: "hidden",
      ...floatShadow,
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
      backgroundColor: colors.border,
      marginHorizontal: 16,
    },
    inputText: { fontSize: 15, color: colors.textPrimary, flex: 1 },
    placeholder: { color: colors.textMuted },

    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary },

    searchHint: {
      fontSize: 12,
      lineHeight: 17,
      color: colors.textTertiary,
      paddingHorizontal: 4,
      marginTop: -2,
      marginBottom: 10,
    },

    predictionsList: { maxHeight: 240 },
    predictionRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 4,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.borderSubtle,
    },
    predictionText: { fontSize: 13, color: colors.textOnSurfaceLight, flex: 1, lineHeight: 18 },

    sectionLabel: {
      fontSize: 10,
      fontWeight: "600",
      color: colors.textTertiary,
      letterSpacing: 0.08,
      marginBottom: 10,
      marginTop: 4,
    },
    quickChip: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingVertical: 8,
      paddingHorizontal: 14,
      marginRight: 8,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    quickChipText: { fontSize: 13, color: colors.textOnSurfaceLight },

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
      color: colors.textPrimary,
      marginBottom: 2,
    },
    cardNudgeSub: { fontSize: 11, color: colors.textSecondary },

    // Confirm
    confirmScroll: { flexGrow: 0, flexShrink: 1 },
    confirmScrollContent: { paddingBottom: 4 },
    confirmHeader: { marginBottom: 14 },
    confirmTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 8,
    },
    confirmDestRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    confirmRouteLine: {
      width: 1.5,
      height: 14,
      backgroundColor: colors.borderStrong,
      marginLeft: 4.5,
      marginVertical: 3,
    },
    routeDot: { width: 10, height: 10, borderRadius: 5 },
    confirmDestText: {
      fontSize: 15,
      lineHeight: 20,
      color: colors.textOnSurfaceLight,
      flex: 1,
      fontWeight: "500",
    },

    scheduleToggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
    },
    scheduleToggleActive: {
      borderColor: "rgba(168,85,247,0.4)",
      backgroundColor: "rgba(168,85,247,0.08)",
    },
    scheduleToggleLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    scheduleToggleText: { fontSize: 14, color: colors.textSecondary, fontWeight: "500" },
    scheduleToggleTextActive: { color: colors.accentPurple },
    togglePill: {
      width: 38,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.textFaint,
      justifyContent: "center",
      paddingHorizontal: 2,
    },
    togglePillActive: { backgroundColor: colors.accentPurple },
    toggleThumb: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: colors.textTertiary,
      alignSelf: "flex-start",
    },
    toggleThumbActive: { backgroundColor: "#fff", alignSelf: "flex-end" },

    paymentSection: { marginBottom: 12 },
    paymentLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    paymentOptions: { gap: 8 },
    paymentOption: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    paymentOptionSelected: {
      borderColor: "rgba(232,80,10,0.4)",
      backgroundColor: "rgba(232,80,10,0.07)",
    },
    paymentOptionTitle: {
      fontSize: 14,
      color: colors.textSecondary,
      fontWeight: "500",
      flex: 1,
    },
    paymentOptionTitleSelected: { color: colors.textPrimary },
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
      color: colors.accentOrange,
      fontWeight: "500",
      flex: 1,
    },

    classSection: {
      marginBottom: 12,
      marginHorizontal: -16,
    },
    classScroll: {
      paddingHorizontal: 16,
      gap: 8,
    },
    classCard: {
      width: 112,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: colors.borderStrong,
      paddingTop: 9,
      paddingBottom: 8,
      paddingHorizontal: 10,
      alignItems: "center",
      position: "relative",
      // Android draws a bordered view's background as a sharp-cornered rect
      // inset inside the rounded border (box-in-a-box). Clipping to the radius
      // fixes it. iOS keeps overflow visible so the drop shadow still renders.
      overflow: Platform.OS === "android" ? "hidden" : "visible",
      shadowColor: "#000",
      shadowOpacity: 0.08,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    classCardSelected: {
      borderColor: colors.accentOrange,
      // Must be OPAQUE: Android renders a translucent background as a sharp
      // rectangle that doesn't reach the rounded border (box-in-a-box). These
      // are the flattened equivalents of a ~6% orange tint per theme.
      backgroundColor: isDark ? "#2A1E17" : "#FEF5F0",
    },
    classCardUnavailable: {
      opacity: 0.4,
    },
    classCheckmark: {
      position: "absolute",
      top: 7,
      right: 7,
    },
    classIcon: {
      marginBottom: 5,
    },
    classCardName: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textPrimary,
      marginBottom: 1,
      textAlign: "center",
      letterSpacing: 0.1,
    },
    classCardNameSelected: { color: colors.accentOrange },
    classCardNameUnavailable: { color: colors.textMuted },
    classCardSeats: {
      fontSize: 10,
      color: colors.textMuted,
      marginBottom: 6,
    },
    classCardSeatsSelected: { color: "rgba(232,80,10,0.6)" },
    classCardFare: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.textPrimary,
      letterSpacing: -0.4,
    },
    classCardFareSelected: { color: colors.accentOrange },
    classCardFareUnavailable: { fontSize: 11, fontWeight: "600", color: colors.textMuted, letterSpacing: 0 },

    fareRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 18,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      marginBottom: 16,
    },
    fareLabel: { fontSize: 14, color: colors.textTertiary, marginBottom: 3 },
    fareNote: { fontSize: 11, color: colors.textMuted },
    fareAmount: {
      fontSize: 30,
      fontWeight: "800",
      color: colors.textPrimary,
      letterSpacing: -0.5,
    },
    fareStrikethrough: {
      fontSize: 14,
      color: colors.textMuted,
      textDecorationLine: "line-through",
    },
    fareDiscountBadge: { fontSize: 11, color: "#A855F7", fontWeight: "600" },
    discountCodeRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 6,
    },
    discountCodeInput: {
      flex: 1,
      fontSize: 14,
      color: colors.textPrimary,
      backgroundColor: colors.surfaceAlt,
      borderRadius: 10,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    discountCodeBtn: {
      paddingHorizontal: 16,
      borderRadius: 10,
      borderWidth: 0.5,
      borderColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
    },
    discountCodeBtnText: { fontSize: 13, fontWeight: "600", color: colors.accentOrange },
    discountCodeError: { fontSize: 12, color: colors.accentRed, marginBottom: 8 },
    discountCodeSuccess: { fontSize: 12, color: "#1D9E75", marginBottom: 8 },
    confirmBtns: { flexDirection: "row", gap: 12, paddingTop: 14 },
    editBtn: {
      flex: 1,
      paddingVertical: 16,
      borderRadius: 14,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    editBtnText: { color: colors.textTertiary, fontSize: 15, fontWeight: "500" },
    bookBtnWrap: { flex: 2 },
    bookBtn: {
      flex: 1,
      paddingVertical: 16,
      borderRadius: 14,
      backgroundColor: colors.accentOrange,
      alignItems: "center",
      justifyContent: "center",
    },
    // Gradient sits behind the label; rounded to match so it clips cleanly
    // without an overflow:hidden on the button (which would kill its shadow).
    bookBtnGradient: { borderRadius: 14 },
    bookBtnInner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    bookBtnText: {
      color: "#fff",
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: 0.2,
    },
  });
};

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
