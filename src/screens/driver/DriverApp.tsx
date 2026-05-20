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

// A ride is "now" if it has no scheduled_at, or that time has already passed
function isRideNow(row: any): boolean {
  if (!row.scheduled_at) return true;
  return new Date(row.scheduled_at) <= new Date();
}

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
    fetchConfirmedScheduledRides();
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

          const isFutureScheduled = !isRideNow(row);

          if (ACTIVE_STATUSES.includes(row.status) && !isFutureScheduled) {
            fetchActiveRide();
            fetchAssignedRide();
            fetchConfirmedScheduledRides();
          } else if (row.status === "completed" || row.status === "cancelled") {
            setActiveRide(null);
            setAssignedRide(null);
            fetchConfirmedScheduledRides();
          } else if (row.status === "assigned") {
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

  // ── Handle notification tap ──────────────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const action = response.actionIdentifier;
        const rideId = response.notification.request.content.data?.rideId;
        if (!rideId || !profile) return;

        if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          await fetchAssignedRide();
          setShowAssigned(true);
        } else if (action === "ACCEPT") {
          const { data: rideCheck } = await supabase
            .from("rides")
            .select("id, status")
            .eq("id", rideId)
            .single();

          if (!rideCheck || rideCheck.status !== "pending") return;

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
    const now = new Date().toISOString();
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ACTIVE_STATUSES)
      .eq("confirmed_by_driver", true)
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
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
      .in("status", ["assigned", "scheduled", "pending"])
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
    <DriverHomeScreen
      assignedRide={assignedRide}
      onOpenAssigned={() => setShowAssignedList(true)}
      confirmedScheduledRides={confirmedScheduledRides}
      onRideAccepted={fetchActiveRide}
    />
  );
}
