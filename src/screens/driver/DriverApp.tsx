import React, { useState, useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useDriverLocationBroadcast } from "../../hooks/useDriverLocationBroadcast";
import DriverHomeScreen from "./DriverHomeScreen";
import DriverActiveRideScreen from "./DriverActiveRideScreen";
import DriverSetupScreen from "./DriverSetupScreen";
import AssignedRideScreen from "./AssignedRideScreen";
import AssignedRidesListScreen from "./AssignedRidesListScreen";
import RideRequestSheet from "./RideRequestSheet";
import Constants from "expo-constants";
import { Alert } from "react-native";

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
  payment_method: string | null;
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
  payment_method: string | null;
}

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

interface DriverRecord {
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
}

interface ConfirmedScheduledRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  scheduled_at: string;
  passenger_name: string | null;
}

const ACTIVE_STATUSES = ["assigned", "driver_arriving", "in_progress"];

function isRideNow(row: any): boolean {
  if (!row.scheduled_at) return true;
  if (row.auto_started) return true; // cron has flipped it live
  return new Date(row.scheduled_at) <= new Date();
}

export default function DriverApp() {
  const { profile } = useAuth();
  useDriverLocationBroadcast(profile?.id);
  const [activeRide, setActiveRide] = useState<ActiveRide | null>(null);
  const [assignedRide, setAssignedRide] = useState<AssignedRide | null>(null);
  const [pendingRide, setPendingRide] = useState<PendingRide | null>(null);
  const [driverRecord, setDriverRecord] = useState<DriverRecord | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(true);
  const [showAssigned, setShowAssigned] = useState(false);
  const [showAssignedList, setShowAssignedList] = useState(false);
  const [confirmedScheduledRides, setConfirmedScheduledRides] = useState<
    ConfirmedScheduledRide[]
  >([]);

  // Ref so handleDeclinePendingRide always reads the latest pendingRide
  // even when called from a stale closure (e.g. timer timeout after 30s)
  const pendingRideRef = useRef<PendingRide | null>(null);
  useEffect(() => {
    pendingRideRef.current = pendingRide;
  }, [pendingRide]);

  // Refs so the realtime callback can check "am I free?" without stale closures
  const activeRideRef = useRef<ActiveRide | null>(null);
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);
  const assignedRideRef = useRef<AssignedRide | null>(null);
  useEffect(() => {
    assignedRideRef.current = assignedRide;
  }, [assignedRide]);

  // Scheduled offers this driver dismissed — stays open for everyone else
  const dismissedOfferIds = useRef<Set<string>>(new Set());

  // Track rides we're currently processing a decline/timeout for so the
  // realtime callback doesn't re-show the popup while the server is resetting
  const decliningRideIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!profile) return;
    fetchDriverRecord();
    fetchActiveRide();
    fetchAssignedRide();
    fetchConfirmedScheduledRides();
  }, [profile]);

  // ── Realtime: watch for ride changes on this driver ──────────
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("driver-ride-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rides",
          filter: "company_id=eq." + profile.company_id,
        },
        async (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as any)?.id;
            if (activeRideRef.current?.id === deletedId) setActiveRide(null);
            if (assignedRideRef.current?.id === deletedId)
              setAssignedRide(null);
            setPendingRide((prev) =>
              prev?.id === deletedId ? null : prev,
            );
            setConfirmedScheduledRides((prev) =>
              prev.filter((r) => r.id !== deletedId),
            );
            return;
          }

          const row = payload.new as any;

          // Unclaimed scheduled offer broadcast to the company — free drivers only
          if (row.status === "scheduled" && !row.driver_id) {
            if (row.company_id !== profile.company_id) return;
            if (activeRideRef.current || assignedRideRef.current) return;
            if (dismissedOfferIds.current.has(row.id)) return;
            setPendingRide((prev) => {
              if (prev?.id === row.id) return prev;
              showRideRequestPopup(row);
              return prev;
            });
            return;
          }

          if (row.driver_id !== profile.id) return;

          const isFutureScheduled = !isRideNow(row);

          if (row.status === "offered") {
            if (decliningRideIds.current.has(row.id)) return;
            setPendingRide((prev) => {
              if (prev?.id === row.id) return prev;
              showRideRequestPopup(row);
              return prev;
            });
          } else if (row.status === "assigned" && row.confirmed_by_driver) {
            fetchActiveRide();
            fetchConfirmedScheduledRides();
          } else if (
            ACTIVE_STATUSES.includes(row.status) &&
            row.confirmed_by_driver &&
            !isFutureScheduled
          ) {
            fetchActiveRide();
            fetchConfirmedScheduledRides();
          } else if (row.status === "completed" || row.status === "cancelled") {
            setActiveRide(null);
            setAssignedRide(null);
            fetchConfirmedScheduledRides();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  // ── Handle notification tap ───────────────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const action = response.actionIdentifier;
        const data = response.notification.request.content.data ?? {};
        const rideId = data.rideId;
        if (!rideId || !profile) return;

        if (data.type === "scheduled_offer") {
          // body tap or ACCEPT both claim; DECLINE just dismisses (it wasn't theirs)
          if (action !== "DECLINE") await claimScheduledRide(rideId);
          return;
        }

        if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          await fetchAssignedRide();
          setShowAssigned(true);
        } else if (action === "ACCEPT") {
          const { error } = await supabase
            .from("rides")
            .update({
              driver_id: profile.id,
              status: "assigned",
              confirmed_by_driver: true,
            })
            .eq("id", rideId)
            .eq("status", "offered");
          if (!error) fetchActiveRide();
        } else if (action === "DECLINE") {
          console.log("Driver declined ride from notification:", rideId);
        }
      },
    );
    return () => sub.remove();
  }, [profile]);

  async function claimScheduledRide(rideId: string) {
    if (!profile) return;
    const { data, error } = await supabase
      .from("rides")
      .update({ driver_id: profile.id, confirmed_by_driver: true })
      .eq("id", rideId)
      .is("driver_id", null) // race-safe: only an unclaimed ride
      .eq("status", "scheduled") // stays 'scheduled' — not active yet
      .select("id");
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    if (!data || data.length === 0) {
      Alert.alert(
        "Already taken",
        "Another driver claimed this scheduled ride.",
      );
      return;
    }
    Alert.alert(
      "Scheduled ride claimed 🗓",
      "It'll go live automatically at pickup time.",
    );
    fetchConfirmedScheduledRides();
  }
  // ── Fetch a ride row and show the RideRequestSheet popup ─────
  async function showRideRequestPopup(rideRow: any) {
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, phone")
      .eq("id", rideRow.passenger_id)
      .maybeSingle();

    setPendingRide({
      id: rideRow.id,
      pickup_address: rideRow.pickup_address,
      dropoff_address: rideRow.dropoff_address,
      pickup_lat: rideRow.pickup_lat,
      pickup_lng: rideRow.pickup_lng,
      dropoff_lat: rideRow.dropoff_lat,
      dropoff_lng: rideRow.dropoff_lng,
      fare_estimate: rideRow.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_phone: passenger?.phone ?? null,
      scheduled_at: rideRow.scheduled_at ?? null,
    });
  }

  // ── Confirm ride (accept from popup or notification) ─────────
  async function confirmRide(rideId: string) {
    if (!profile) return;
    const { error } = await supabase
      .from("rides")
      .update({ confirmed_by_driver: true, status: "assigned" })
      .eq("id", rideId)
      .eq("driver_id", profile.id)
      .eq("status", "offered");

    if (!error) {
      setPendingRide(null);
    }
  }

  // ── Decline and immediately trigger reassignment server-side ──
  async function declineAndReassign(rideId: string, timedOut: boolean = false) {
    if (!profile) return;
    const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl;
    const supabaseAnonKey = Constants.expoConfig?.extra?.supabaseAnonKey;

    decliningRideIds.current.add(rideId);
    setPendingRide(null);

    try {
      await fetch(`${supabaseUrl}/functions/v1/assign-ride`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify({
          ride_id: rideId,
          // Hard decline → declined_by_driver_id (excluded permanently)
          // Timeout → timed_out_driver_id (eligible again on second pass)
          ...(timedOut
            ? { timed_out_driver_id: profile.id }
            : { declined_by_driver_id: profile.id }),
        }),
      });
    } catch (e) {
      console.error("[declineAndReassign] fetch error:", e);
    } finally {
      setTimeout(() => {
        decliningRideIds.current.delete(rideId);
      }, 3000);
    }
  }

  // ── Accept from popup sheet ───────────────────────────────────
  async function handleAcceptPendingRide() {
    const ride = pendingRideRef.current;
    if (!ride) return;
    if (ride.scheduled_at) {
      await claimScheduledRide(ride.id);
      setPendingRide(null);
    } else {
      await confirmRide(ride.id);
    }
  }

  // ── Decline from popup sheet (manual or timeout) ─────────────
  // Uses pendingRideRef so the timer callback (fired 30s after mount)
  // always reads the current ride, not a stale closure value
  async function handleDeclinePendingRide(timedOut: boolean) {
    const ride = pendingRideRef.current;
    if (!ride) return;
    if (ride.scheduled_at) {
      // Unclaimed offer — just dismiss locally, it stays open for others
      dismissedOfferIds.current.add(ride.id);
      setPendingRide(null);
      return;
    }
    await declineAndReassign(ride.id, timedOut);
  }

  async function fetchDriverRecord() {
    if (!profile) return;
    const { data } = await supabase
      .from("drivers")
      .select("vehicle_make, vehicle_model, plate_number")
      .eq("id", profile.id)
      .single();
    setDriverRecord(data);
    setLoadingDriver(false);
  }

  async function fetchActiveRide() {
    if (!profile) return;
    const now = new Date().toISOString();
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ACTIVE_STATUSES)
      .eq("confirmed_by_driver", true)
      .or(`scheduled_at.is.null,scheduled_at.lte.${now},auto_started.eq.true`)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!rides || rides.length === 0) {
      setActiveRide(null);
      return;
    }
    const ride = rides[0];
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, phone")
      .eq("id", ride.passenger_id)
      .single();
    setActiveRide({
      id: ride.id,
      status: ride.status,
      pickup_address: ride.pickup_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_address: ride.dropoff_address,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_phone: passenger?.phone ?? null,
      payment_method: ride.payment_method ?? null,
    });
  }

  async function fetchConfirmedScheduledRides() {
    if (!profile) return;
    const now = new Date().toISOString();
    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .eq("confirmed_by_driver", true)
      .in("status", ["assigned", "scheduled", "pending"])
      .not("scheduled_at", "is", null)
      .gt("scheduled_at", now)
      .order("scheduled_at", { ascending: true });
    if (!data) return;
    const enriched = await Promise.all(
      data.map(async (ride) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name")
          .eq("id", ride.passenger_id)
          .single();
        return {
          id: ride.id,
          pickup_address: ride.pickup_address,
          dropoff_address: ride.dropoff_address,
          fare_estimate: ride.fare_estimate,
          scheduled_at: ride.scheduled_at,
          passenger_name: p?.name ?? null,
        };
      }),
    );
    setConfirmedScheduledRides(enriched);
  }

  async function fetchAssignedRide() {
    if (!profile) return;
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ["offered", "assigned", "scheduled", "pending"])
      .eq("confirmed_by_driver", false)
      .order("scheduled_at", { ascending: true, nullsFirst: false })
      .limit(1);
    if (!rides || rides.length === 0) {
      setAssignedRide(null);
      return;
    }
    const ride = rides[0];
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, phone")
      .eq("id", ride.passenger_id)
      .single();
    setAssignedRide({
      id: ride.id,
      pickup_address: ride.pickup_address,
      dropoff_address: ride.dropoff_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      scheduled_at: ride.scheduled_at,
      passenger_name: passenger?.name ?? null,
      passenger_phone: passenger?.phone ?? null,
      payment_method: ride.payment_method ?? null,
    });
  }

  function handleRideStatusChange(newStatus: string) {
    if (!activeRide) return;
    setActiveRide({ ...activeRide, status: newStatus });
  }

  function handleRideComplete() {
    setActiveRide(null);
    fetchConfirmedScheduledRides();
  }

  function handleSetupComplete() {
    fetchDriverRecord();
  }

  async function handleAcceptRide() {
    const wasScheduled = !!assignedRide?.scheduled_at;
    setAssignedRide(null);
    setShowAssigned(false);
    if (wasScheduled) {
      fetchConfirmedScheduledRides();
    } else {
      await fetchActiveRide();
    }
  }

  function handleDeclineRide() {
    setAssignedRide(null);
    setShowAssigned(false);
  }

  if (loadingDriver) return null;

  if (!driverRecord?.vehicle_make || !driverRecord?.plate_number) {
    return <DriverSetupScreen onComplete={handleSetupComplete} />;
  }

  if (showAssigned && assignedRide) {
    return (
      <AssignedRideScreen
        ride={assignedRide}
        onAccept={handleAcceptRide}
        onDecline={handleDeclineRide}
        onClose={() => setShowAssigned(false)}
      />
    );
  }

  if (activeRide) {
    return (
      <DriverActiveRideScreen
        key={activeRide.id}
        ride={activeRide}
        onRideComplete={handleRideComplete}
        onStatusChange={handleRideStatusChange}
      />
    );
  }

  if (showAssignedList) {
    return (
      <AssignedRidesListScreen
        onClose={() => setShowAssignedList(false)}
        hasActiveRide={!!activeRide}
        onAccepted={() => {
          setShowAssignedList(false);
          fetchActiveRide();
          fetchConfirmedScheduledRides();
        }}
      />
    );
  }

  return (
    <>
      <DriverHomeScreen
        assignedRide={assignedRide}
        onOpenAssigned={() => setShowAssignedList(true)}
        confirmedScheduledRides={confirmedScheduledRides}
        onRideAccepted={fetchActiveRide}
      />
      {pendingRide && (
        <RideRequestSheet
          ride={pendingRide}
          onAccept={handleAcceptPendingRide}
          onDecline={handleDeclinePendingRide}
        />
      )}
    </>
  );
}
