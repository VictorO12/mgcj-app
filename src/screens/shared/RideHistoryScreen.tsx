import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface RideRecord {
  id: string;
  status: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  fare_final: number | null;
  payment_method: string;
  created_at: string;
  other_party_name: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#1D9E75",
  cancelled: "#E24B4A",
  in_progress: "#E8500A",
  assigned: "#F59E0B",
  driver_arriving: "#F59E0B",
  pending: "#6B7280",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  cancelled: "Cancelled",
  in_progress: "In progress",
  assigned: "Assigned",
  driver_arriving: "Arriving",
  pending: "Pending",
};

interface Props {
  onClose: () => void;
}

export default function RideHistoryScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "completed" | "cancelled">(
    "all",
  );

  const isDriver = profile?.role === "driver";

  useEffect(() => {
    fetchRides();
  }, [profile]);

  async function fetchRides() {
    if (!profile) return;
    setLoading(true);

    const query = supabase
      .from("rides")
      .select("*")
      .in("status", ["completed", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(50);

    if (isDriver) {
      query.eq("driver_id", profile.id);
    } else {
      query.eq("passenger_id", profile.id);
    }

    const { data: rideRows, error } = await query;
    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }
    if (!rideRows) {
      setLoading(false);
      return;
    }

    // Fetch the other party's name for each ride
    const enriched = await Promise.all(
      rideRows.map(async (ride) => {
        const otherId = isDriver ? ride.passenger_id : ride.driver_id;
        let otherName: string | null = null;
        if (otherId) {
          const { data: p } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", otherId)
            .single();
          otherName = p?.name ?? null;
        }
        return {
          id: ride.id,
          status: ride.status,
          pickup_address: ride.pickup_address,
          dropoff_address: ride.dropoff_address,
          fare_estimate: ride.fare_estimate,
          fare_final: ride.fare_final,
          payment_method: ride.payment_method,
          created_at: ride.created_at,
          other_party_name: otherName,
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

  function formatDate(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor(
      (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString("en-CA", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const filtered = rides.filter((r) => {
    if (filter === "all") return true;
    return r.status === filter;
  });

  const totalEarnings = rides
    .filter((r) => r.status === "completed")
    .reduce((sum, r) => sum + (r.fare_final ?? r.fare_estimate ?? 0), 0);

  const completedCount = rides.filter((r) => r.status === "completed").length;
  const cancelledCount = rides.filter((r) => r.status === "cancelled").length;

  return (
    <View style={styles.container}>
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ride history</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#E8500A"
          />
        }
      >
        {/* ── STATS ROW ── */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{completedCount}</Text>
            <Text style={styles.statLabel}>Completed</Text>
          </View>
          {isDriver && (
            <View style={[styles.statCard, styles.statCardAccent]}>
              <Text style={[styles.statValue, { color: "#1D9E75" }]}>
                ${totalEarnings.toFixed(2)}
              </Text>
              <Text style={styles.statLabel}>Total earned</Text>
            </View>
          )}
          <View style={styles.statCard}>
            <Text
              style={[
                styles.statValue,
                cancelledCount > 0 && { color: "#E24B4A" },
              ]}
            >
              {cancelledCount}
            </Text>
            <Text style={styles.statLabel}>Cancelled</Text>
          </View>
        </View>

        {/* ── FILTER TABS ── */}
        <View style={styles.filterRow}>
          {(["all", "completed", "cancelled"] as const).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.filterTab, filter === f && styles.filterTabActive]}
              onPress={() => setFilter(f)}
            >
              <Text
                style={[
                  styles.filterTabText,
                  filter === f && styles.filterTabTextActive,
                ]}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── RIDE LIST ── */}
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color="#E8500A" size="large" />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="car-outline" size={48} color="#374151" />
            <Text style={styles.emptyTitle}>No rides yet</Text>
            <Text style={styles.emptySubtitle}>
              {isDriver
                ? "Your completed rides will appear here"
                : "Your trip history will appear here"}
            </Text>
          </View>
        ) : (
          <View style={styles.rideList}>
            {filtered.map((ride, index) => (
              <View key={ride.id} style={styles.rideCard}>
                {/* Date + status */}
                <View style={styles.rideCardTop}>
                  <View style={styles.dateRow}>
                    <Text style={styles.rideDate}>
                      {formatDate(ride.created_at)}
                    </Text>
                    <Text style={styles.rideTime}>
                      {formatTime(ride.created_at)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      {
                        backgroundColor: `${STATUS_COLORS[ride.status]}18`,
                        borderColor: `${STATUS_COLORS[ride.status]}40`,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        { color: STATUS_COLORS[ride.status] },
                      ]}
                    >
                      {STATUS_LABELS[ride.status] ?? ride.status}
                    </Text>
                  </View>
                </View>

                {/* Route */}
                <View style={styles.routeWrap}>
                  <View style={styles.routeRow}>
                    <View
                      style={[styles.routeDot, { backgroundColor: "#4a9eff" }]}
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
                        styles.routeDot,
                        { backgroundColor: "#E8500A", borderRadius: 3 },
                      ]}
                    />
                    <Text style={styles.routeText} numberOfLines={1}>
                      {ride.dropoff_address}
                    </Text>
                  </View>
                </View>

                {/* Footer */}
                <View style={styles.rideCardFooter}>
                  {ride.other_party_name && (
                    <View style={styles.otherPartyRow}>
                      <Ionicons
                        name={isDriver ? "person-outline" : "car-outline"}
                        size={13}
                        color="#6B7280"
                      />
                      <Text style={styles.otherPartyText}>
                        {isDriver ? "Passenger" : "Driver"}:{" "}
                        {ride.other_party_name}
                      </Text>
                    </View>
                  )}
                  <View style={styles.fareRow}>
                    <Ionicons name="cash-outline" size={13} color="#6B7280" />
                    <Text style={styles.fareText}>
                      ${(ride.fare_final ?? ride.fare_estimate ?? 0).toFixed(2)}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
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
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1E2A3A",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#F1F5F9" },

  statsRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  statCardAccent: {
    borderColor: "rgba(29,158,117,0.25)",
  },
  statValue: { fontSize: 22, fontWeight: "700", color: "#F1F5F9" },
  statLabel: { fontSize: 11, color: "#6B7280", marginTop: 3 },

  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  filterTabActive: {
    backgroundColor: "#E8500A",
    borderColor: "#E8500A",
  },
  filterTabText: { fontSize: 13, fontWeight: "500", color: "#6B7280" },
  filterTabTextActive: { color: "#fff" },

  loadingWrap: { paddingTop: 60, alignItems: "center" },
  emptyWrap: { paddingTop: 60, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#4B5563" },
  emptySubtitle: {
    fontSize: 13,
    color: "#374151",
    textAlign: "center",
    paddingHorizontal: 40,
  },

  rideList: { paddingHorizontal: 20, gap: 10 },
  rideCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },

  rideCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  dateRow: { gap: 2 },
  rideDate: { fontSize: 13, fontWeight: "600", color: "#F1F5F9" },
  rideTime: { fontSize: 11, color: "#6B7280" },
  statusBadge: {
    borderRadius: 20,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 0.5,
  },
  statusText: { fontSize: 11, fontWeight: "600" },

  routeWrap: { marginBottom: 12 },
  routeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  routeText: { fontSize: 13, color: "#CBD5E1", flex: 1 },
  routeLineWrap: { paddingLeft: 3, paddingVertical: 2 },
  routeLine: {
    width: 1.5,
    height: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 2,
  },

  rideCardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  otherPartyRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  otherPartyText: { fontSize: 12, color: "#6B7280" },
  fareRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  fareText: { fontSize: 13, fontWeight: "600", color: "#F1F5F9" },
});
