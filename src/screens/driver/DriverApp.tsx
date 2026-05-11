import React, { useState, useEffect } from "react";
import * as Notifications from "expo-notifications";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import DriverHomeScreen from "./DriverHomeScreen";
import DriverActiveRideScreen from "./DriverActiveRideScreen";
import DriverSetupScreen from "./DriverSetupScreen";
import AssignedRideScreen from "./AssignedRideScreen";
import AssignedRidesListScreen from "./AssignedRidesListScreen";
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

export default function DriverApp() {
  const { profile } = useAuth();
  const [activeRide, setActiveRide] = useState<ActiveRide | null>(null);
  const [assignedRide, setAssignedRide] = useState<AssignedRide | null>(null);
  const [driverRecord, setDriverRecord] = useState<DriverRecord | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(true);
  const [showAssigned, setShowAssigned] = useState(false);
  const [showAssignedList, setShowAssignedList] = useState(false);
  const [confirmedScheduledRides, setConfirmedScheduledRides] = useState<
    ConfirmedScheduledRide[]
  >([]);
  useEffect(() => {
    if (!profile) return;
    fetchDriverRecord();
    fetchActiveRide();
    fetchAssignedRide();
    fetchConfirmedScheduledRides(); // ← was missing ()
  }, [profile]);

  // ── Realtime: watch for ride changes ────────────────────────
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("driver-ride-" + profile.id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides" },
        (payload) => {
          const row = payload.new as any;
          if (row.driver_id !== profile.id) return;

          if (row.status === "completed" || row.status === "cancelled") {
            setActiveRide(null);
            setAssignedRide(null);
            fetchConfirmedScheduledRides();
          } else {
            // Refresh everything on any other change
            fetchActiveRide();
            fetchAssignedRide();
            fetchConfirmedScheduledRides();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  // ── Handle notification tap — open assigned ride screen ─────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const action = response.actionIdentifier;
        const rideId = response.notification.request.content.data?.rideId;
        if (!rideId || !profile) return;

        if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          // Tapped the notification body — open assigned ride screen
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
            .eq("status", "pending");
          if (!error) fetchActiveRide();
        } else if (action === "DECLINE") {
          console.log("Driver declined ride from notification:", rideId);
        }
      },
    );
    return () => sub.remove();
  }, [profile]);

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
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ACTIVE_STATUSES)
      .eq("confirmed_by_driver", true) // Only show confirmed active rides
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
    });
  }

  async function fetchConfirmedScheduledRides() {
    if (!profile) return;
    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .eq("confirmed_by_driver", true)
      .in("status", ["assigned", "scheduled"])
      .not("scheduled_at", "is", null)
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
      .in("status", ["assigned", "scheduled"])
      .eq("confirmed_by_driver", false) // only unresponded ones for the badge
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
    });
  }

  function handleRideComplete() {
    setActiveRide(null);
  }

  function handleSetupComplete() {
    fetchDriverRecord();
  }

  async function handleAcceptRide() {
    setAssignedRide(null);
    setShowAssigned(false);
    await fetchActiveRide();
    fetchConfirmedScheduledRides();
  }

  function handleDeclineRide() {
    setAssignedRide(null);
    setShowAssigned(false);
  }

  if (loadingDriver) return null;

  // Setup screen if vehicle details missing
  if (!driverRecord?.vehicle_make || !driverRecord?.plate_number) {
    return <DriverSetupScreen onComplete={handleSetupComplete} />;
  }

  // Assigned ride confirmation screen
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

  // Active ride navigation screen
  if (activeRide) {
    return (
      <DriverActiveRideScreen
        ride={activeRide}
        onRideComplete={handleRideComplete}
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
        }}
      />
    );
  }
  // Home screen — pass assignedRide so badge shows
  return (
    <DriverHomeScreen
      assignedRide={assignedRide}
      onOpenAssigned={() => setShowAssignedList(true)}
      confirmedScheduledRides={confirmedScheduledRides}
    />
  );
}
