import React, { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import DriverHomeScreen from "./DriverHomeScreen";
import DriverActiveRideScreen from "./DriverActiveRideScreen";
import DriverSetupScreen from "./DriverSetupScreen";

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

interface DriverRecord {
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
}

const ACTIVE_STATUSES = ["assigned", "driver_arriving", "in_progress"];

export default function DriverApp() {
  const { profile } = useAuth();
  const [activeRide, setActiveRide] = useState<ActiveRide | null>(null);
  const [driverRecord, setDriverRecord] = useState<DriverRecord | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(true);

  useEffect(() => {
    if (!profile) return;
    fetchDriverRecord();
    fetchActiveRide();
  }, [profile]);

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
        },
        (payload) => {
          const row = payload.new as any;
          if (row.driver_id !== profile.id) return;
          if (ACTIVE_STATUSES.includes(row.status)) {
            fetchActiveRide();
          } else if (row.status === "completed" || row.status === "cancelled") {
            setActiveRide(null);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
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

  function handleRideComplete() {
    setActiveRide(null);
  }

  function handleSetupComplete() {
    fetchDriverRecord();
  }

  if (loadingDriver) return null;

  // Show setup screen if vehicle details are missing
  if (!driverRecord?.vehicle_make || !driverRecord?.plate_number) {
    return <DriverSetupScreen onComplete={handleSetupComplete} />;
  }

  if (activeRide) {
    return (
      <DriverActiveRideScreen
        ride={activeRide}
        onRideComplete={handleRideComplete}
      />
    );
  }

  return <DriverHomeScreen />;
}
