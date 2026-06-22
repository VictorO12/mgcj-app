import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface ScheduledRide {
  id: string;
  status: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  scheduled_at: string;
  driver_name: string | null;
  driver_vehicle: string | null;
}

interface Props {
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#6B7280",
  assigned: "#A855F7",
  scheduled: "#A855F7",
  driver_arriving: "#F59E0B",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting driver",
  assigned: "Driver assigned",
  scheduled: "Confirmed",
  driver_arriving: "Driver arriving",
};

export default function ScheduledRidesScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const [rides, setRides] = useState<ScheduledRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  useEffect(() => {
    fetchRides();
  }, [profile]);

  // Realtime: keep this list live while it's open (claims, cancellations,
  // dispatch edits elsewhere shouldn't require a manual pull-to-refresh).
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("scheduled-rides-list-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rides",
          filter: "passenger_id=eq." + profile.id,
        },
        () => fetchRides(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  async function fetchRides() {
    if (!profile) return;
    setLoading(true);

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("rides")
      .select("*")
      .eq("passenger_id", profile.id)
      .not("scheduled_at", "is", null)
      .gte("scheduled_at", now)
      .in("status", ["pending", "assigned", "scheduled", "driver_arriving"])
      .order("scheduled_at", { ascending: true });

    if (error || !data) {
      setLoading(false);
      return;
    }

    const enriched = await Promise.all(
      data.map(async (ride) => {
        let driverName: string | null = null;
        let driverVehicle: string | null = null;
        if (ride.driver_id) {
          const { data: p } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", ride.driver_id)
            .single();
          const { data: d } = await supabase
            .from("drivers")
            .select("vehicle_make, vehicle_model")
            .eq("id", ride.driver_id)
            .single();
          driverName = p?.name ?? null;
          driverVehicle = d
            ? [d.vehicle_make, d.vehicle_model].filter(Boolean).join(" ")
            : null;
        }
        return {
          id: ride.id,
          status: ride.status,
          pickup_address: ride.pickup_address,
          dropoff_address: ride.dropoff_address,
          fare_estimate: ride.fare_estimate,
          scheduled_at: ride.scheduled_at,
          driver_name: driverName,
          driver_vehicle: driverVehicle,
        };
      }),
    );

    setRides(enriched);
    setLoading(false);
  }

  async function onRefresh() {
    setRefreshing(true);
    await fetchRides();
    setRefreshing(false);
  }

  function confirmCancel(ride: ScheduledRide) {
    Alert.alert(
      "Cancel ride?",
      `Cancel your scheduled ride on ${formatDate(ride.scheduled_at)}?`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Cancel ride",
          style: "destructive",
          onPress: () => cancelRide(ride.id),
        },
      ],
    );
  }

  async function cancelRide(id: string) {
    setCancelling(id);
    const { error } = await supabase
      .from("rides")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("passenger_id", profile?.id);
    setCancelling(null);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setRides((prev) => prev.filter((r) => r.id !== id));
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function timeUntil(iso: string) {
    const diff = new Date(iso).getTime() - Date.now();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `in ${days} day${days > 1 ? "s" : ""}`;
    }
    if (hours > 0) return `in ${hours}h ${mins}m`;
    return `in ${mins}m`;
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Scheduled rides</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#E8500A" size="large" />
        </View>
      ) : rides.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}>
            <Ionicons name="calendar-outline" size={36} color="#374151" />
          </View>
          <Text style={styles.emptyTitle}>No upcoming rides</Text>
          <Text style={styles.emptySub}>
            Schedule a ride from the home screen and it will appear here.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#E8500A"
            />
          }
        >
          {rides.map((ride) => {
            const isUnclaimed =
              ride.status === "scheduled" && !ride.driver_name;
            const statusColor = isUnclaimed
              ? "#6B7280"
              : (STATUS_COLORS[ride.status] ?? "#6B7280");
            const statusLabel = isUnclaimed
              ? "Finding a driver"
              : ride.status === "scheduled"
                ? "Confirmed"
                : (STATUS_LABELS[ride.status] ?? ride.status);
            const isCancelling = cancelling === ride.id;

            return (
              <View key={ride.id} style={styles.card}>
                {/* Time + status row */}
                <View style={styles.cardTopRow}>
                  <View style={styles.timeWrap}>
                    <Ionicons name="calendar" size={14} color="#A855F7" />
                    <Text style={styles.timeText}>
                      {formatDate(ride.scheduled_at)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      { borderColor: statusColor + "55" },
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor },
                      ]}
                    />
                    <Text style={[styles.statusText, { color: statusColor }]}>
                      {statusLabel}
                    </Text>
                  </View>
                </View>

                {/* Countdown */}
                <Text style={styles.countdown}>
                  {timeUntil(ride.scheduled_at)}
                </Text>

                {/* Route */}
                <View style={styles.route}>
                  <View style={styles.routeRow}>
                    <View
                      style={[styles.dot, { backgroundColor: "#4a9eff" }]}
                    />
                    <Text style={styles.routeText} numberOfLines={1}>
                      {ride.pickup_address}
                    </Text>
                  </View>
                  <View style={styles.routeLineWrap}>
                    <View style={styles.routeLine} />
                  </View>
                  <View style={styles.routeRow}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: "#E8500A", borderRadius: 3 },
                      ]}
                    />
                    <Text style={styles.routeText} numberOfLines={1}>
                      {ride.dropoff_address}
                    </Text>
                  </View>
                </View>

                {/* Fare */}
                {ride.fare_estimate != null && (
                  <View style={styles.fareRow}>
                    <Ionicons name="cash-outline" size={14} color="#6B7280" />
                    <Text style={styles.fareText}>
                      Est. ${ride.fare_estimate.toFixed(2)} · Cash
                    </Text>
                  </View>
                )}

                {/* Driver info (if assigned) */}
                {ride.driver_name && (
                  <View style={styles.driverRow}>
                    <Ionicons
                      name="person-circle-outline"
                      size={14}
                      color="#6B7280"
                    />
                    <Text style={styles.driverText}>
                      {ride.driver_name}
                      {ride.driver_vehicle ? ` · ${ride.driver_vehicle}` : ""}
                    </Text>
                  </View>
                )}

                {/* Cancel button */}
                <TouchableOpacity
                  style={[styles.cancelBtn, isCancelling && { opacity: 0.5 }]}
                  onPress={() => confirmCancel(ride)}
                  disabled={isCancelling}
                  activeOpacity={0.8}
                >
                  {isCancelling ? (
                    <ActivityIndicator color="#F87171" size="small" />
                  ) : (
                    <Text style={styles.cancelBtnText}>Cancel ride</Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111827",
    paddingTop: Platform.OS === "ios" ? 56 : 40,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.07)",
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F1F5F9",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F1F5F9",
    textAlign: "center",
  },
  emptySub: {
    fontSize: 13,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 20,
  },
  list: {
    padding: 16,
    gap: 14,
  },
  card: {
    backgroundColor: "#1E2A3A",
    borderRadius: 18,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 10,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  timeWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  timeText: {
    fontSize: 13,
    color: "#A855F7",
    fontWeight: "600",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 20,
    borderWidth: 0.5,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
  countdown: {
    fontSize: 12,
    color: "#4B5563",
    fontWeight: "500",
    marginTop: -4,
  },
  route: {
    backgroundColor: "rgba(0,0,0,0.2)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.05)",
  },
  routeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    flexShrink: 0,
  },
  routeText: {
    fontSize: 13,
    color: "#CBD5E1",
    flex: 1,
  },
  routeLineWrap: {
    paddingLeft: 3,
    paddingVertical: 3,
  },
  routeLine: {
    width: 1.5,
    height: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 3.5,
  },
  fareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  fareText: {
    fontSize: 13,
    color: "#6B7280",
  },
  driverRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  driverText: {
    fontSize: 13,
    color: "#6B7280",
  },
  cancelBtn: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.3)",
    alignItems: "center",
    backgroundColor: "rgba(248,113,113,0.07)",
  },
  cancelBtnText: {
    color: "#F87171",
    fontSize: 13,
    fontWeight: "600",
  },
});
