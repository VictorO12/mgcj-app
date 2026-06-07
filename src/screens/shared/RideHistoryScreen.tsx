import React, { useState, useEffect, useRef } from "react";
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
import RideReviewModal from "../../components/RideReviewModal";
import DriverProfileSheet from "../../components/DriverProfileSheet";

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
  other_party_id: string | null;
  review_rating: number | null;
  received_rating: number | null;
  driver_id: string | null;
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

  const [reviewTarget, setReviewTarget] = useState<{
    rideId: string;
    driverId: string;
    driverName: string | null;
  } | null>(null);

  // Driver profile sheet
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);

  const isDriver = profile?.role === "driver";
  const fetchRidesRef = useRef<() => Promise<void>>();

  useEffect(() => {
    fetchRides();
  }, [profile]);

  // Realtime: driver sees new ratings come in live
  useEffect(() => {
    if (!profile || !isDriver) return;
    const channel = supabase
      .channel("driver-reviews-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ride_reviews",
          filter: `driver_id=eq.${profile.id}`,
        },
        (payload) => {
          const review = payload.new as any;
          setRides((prev) =>
            prev.map((r) =>
              r.id === review.ride_id
                ? { ...r, received_rating: review.rating }
                : r,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile, isDriver]);

  async function fetchRides() {
    if (!profile) return;
    setLoading(true);

    const query = supabase
      .from("rides")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (isDriver) {
      query.eq("driver_id", profile.id);
    } else {
      query.eq("passenger_id", profile.id);
    }

    const { data: rideRows, error } = await query;
    if (error || !rideRows) {
      setLoading(false);
      return;
    }

    const completedIds = rideRows
      .filter((r) => r.status === "completed")
      .map((r) => r.id);

    let reviewMap: Record<string, number> = {};
    if (completedIds.length > 0) {
      const { data: reviews } = await supabase
        .from("ride_reviews")
        .select("ride_id, rating")
        .in("ride_id", completedIds);
      reviews?.forEach((rv) => {
        reviewMap[rv.ride_id] = rv.rating;
      });
    }

    const enriched = await Promise.all(
      rideRows.map(async (ride) => {
        const otherId = isDriver ? ride.passenger_id : ride.driver_id;
        let otherName: string | null = null;
        if (otherId) {
          const { data: p } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", otherId)
            .maybeSingle();
          otherName = p?.name ?? null;
        }
        const hasReview = reviewMap[ride.id] != null;
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
          other_party_id: otherId ?? null,
          review_rating: !isDriver && hasReview ? reviewMap[ride.id] : null,
          received_rating: isDriver && hasReview ? reviewMap[ride.id] : null,
          driver_id: ride.driver_id ?? null,
        };
      }),
    );

    setRides(enriched);
    setLoading(false);
  }

  fetchRidesRef.current = fetchRides;

  async function onRefresh() {
    setRefreshing(true);
    await fetchRides();
    setRefreshing(false);
  }

  function handleReviewDismiss(submitted: boolean, rating?: number) {
    const targetId = reviewTarget?.rideId;
    setReviewTarget(null);
    if (submitted && targetId && rating != null) {
      setRides((prev) =>
        prev.map((r) =>
          r.id === targetId ? { ...r, review_rating: rating } : r,
        ),
      );
    }
    fetchRidesRef.current?.();
  }

  function openDriverProfile(driverId: string) {
    setSelectedDriverId(driverId);
    setProfileSheetVisible(true);
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

  function getDayKey(iso: string) {
    return new Date(iso).toLocaleDateString("en-CA");
  }

  function groupByDay(rideList: RideRecord[]) {
    const groups: { label: string; key: string; rides: RideRecord[] }[] = [];
    const seen: Record<string, number> = {};
    for (const ride of rideList) {
      const key = getDayKey(ride.created_at);
      if (seen[key] === undefined) {
        seen[key] = groups.length;
        groups.push({ key, label: formatDate(ride.created_at), rides: [] });
      }
      groups[seen[key]].rides.push(ride);
    }
    return groups;
  }

  const filtered = rides.filter((r) => {
    if (filter === "all") return true;
    return r.status === filter;
  });

  const totalEarnings = rides
    .filter((r) => r.status === "completed")
    .reduce((sum, r) => sum + (r.fare_final ?? r.fare_estimate ?? 0), 0);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ride history</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Driver summary strip */}
      {isDriver && (
        <View style={styles.summaryStrip}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>
              {rides.filter((r) => r.status === "completed").length}
            </Text>
            <Text style={styles.summaryLabel}>Rides</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>${totalEarnings.toFixed(2)}</Text>
            <Text style={styles.summaryLabel}>Earned</Text>
          </View>
        </View>
      )}

      {/* Filter tabs */}
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
        <ScrollView
          style={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#E8500A"
            />
          }
        >
          <View style={styles.rideList}>
            {groupByDay(filtered).map((group) => (
              <View key={group.key}>
                {/* Day separator */}
                <View style={styles.daySeparator}>
                  <View style={styles.daySeparatorLine} />
                  <Text style={styles.daySeparatorLabel}>{group.label}</Text>
                  <View style={styles.daySeparatorLine} />
                </View>

                <View style={styles.dayGroup}>
                  {group.rides.map((ride) => (
                    <View key={ride.id} style={styles.rideCard}>
                      {/* Time + status */}
                      <View style={styles.rideCardTop}>
                        <Text style={styles.rideTime}>
                          {formatTime(ride.created_at)}
                        </Text>
                        <View
                          style={[
                            styles.statusBadge,
                            {
                              backgroundColor: `${STATUS_COLORS[ride.status] ?? "#6B7280"}18`,
                              borderColor: `${STATUS_COLORS[ride.status] ?? "#6B7280"}40`,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusText,
                              {
                                color: STATUS_COLORS[ride.status] ?? "#6B7280",
                              },
                            ]}
                          >
                            {STATUS_LABELS[ride.status] ?? ride.status}
                          </Text>
                        </View>
                      </View>

                      {/* Other party */}
                      {ride.other_party_name && (
                        <View style={styles.otherPartyRow}>
                          <Text style={styles.otherParty}>
                            {isDriver ? "Passenger" : "Driver"}:{" "}
                            <Text style={styles.otherPartyName}>
                              {ride.other_party_name}
                            </Text>
                          </Text>
                          {!isDriver && ride.other_party_id && (
                            <TouchableOpacity
                              style={styles.viewProfileBtn}
                              onPress={() =>
                                openDriverProfile(ride.other_party_id!)
                              }
                              activeOpacity={0.7}
                            >
                              <Ionicons
                                name="person-outline"
                                size={11}
                                color="#93C5FD"
                              />
                              <Text style={styles.viewProfileBtnText}>
                                View profile
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}

                      {/* Route */}
                      <View style={styles.routeWrap}>
                        <View style={styles.routeRow}>
                          <View
                            style={[
                              styles.routeDot,
                              { backgroundColor: "#4a9eff" },
                            ]}
                          />
                          <Text style={styles.routeText} numberOfLines={1}>
                            {ride.pickup_address}
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
                            {ride.dropoff_address}
                          </Text>
                        </View>
                      </View>

                      {/* Fare */}
                      {(ride.fare_final ?? ride.fare_estimate) != null && (
                        <View style={styles.fareRow}>
                          <Text style={styles.fareLabel}>
                            {ride.fare_final ? "Final fare" : "Est. fare"}
                          </Text>
                          <Text style={styles.fareAmount}>
                            $
                            {(ride.fare_final ?? ride.fare_estimate)!.toFixed(
                              2,
                            )}
                          </Text>
                        </View>
                      )}

                      {/* Passenger: review section */}
                      {!isDriver && ride.status === "completed" && (
                        <View style={styles.reviewSection}>
                          {ride.review_rating != null ? (
                            <View style={styles.reviewedRow}>
                              <View style={styles.starsReadOnly}>
                                {[1, 2, 3, 4, 5].map((s) => (
                                  <Ionicons
                                    key={s}
                                    name={
                                      ride.review_rating! >= s
                                        ? "star"
                                        : "star-outline"
                                    }
                                    size={16}
                                    color={
                                      ride.review_rating! >= s
                                        ? "#F59E0B"
                                        : "#374151"
                                    }
                                  />
                                ))}
                              </View>
                              <Text style={styles.reviewedLabel}>
                                {ride.review_rating}/5 · Your rating
                              </Text>
                            </View>
                          ) : (
                            <TouchableOpacity
                              style={styles.rateBtn}
                              onPress={() =>
                                setReviewTarget({
                                  rideId: ride.id,
                                  driverId: ride.other_party_id!,
                                  driverName: ride.other_party_name,
                                })
                              }
                            >
                              <Ionicons
                                name="star-outline"
                                size={15}
                                color="#F59E0B"
                              />
                              <Text style={styles.rateBtnText}>
                                Rate this ride
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}

                      {/* Driver: received rating section */}
                      {isDriver && ride.status === "completed" && (
                        <View style={styles.reviewSection}>
                          {ride.received_rating != null ? (
                            <View style={styles.reviewedRow}>
                              <View style={styles.starsReadOnly}>
                                {[1, 2, 3, 4, 5].map((s) => (
                                  <Ionicons
                                    key={s}
                                    name={
                                      ride.received_rating! >= s
                                        ? "star"
                                        : "star-outline"
                                    }
                                    size={16}
                                    color={
                                      ride.received_rating! >= s
                                        ? "#F59E0B"
                                        : "#374151"
                                    }
                                  />
                                ))}
                              </View>
                              <Text style={styles.reviewedLabel}>
                                {ride.received_rating}/5 · Passenger rating
                              </Text>
                            </View>
                          ) : (
                            <Text style={styles.noRatingText}>
                              No rating yet
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* Review modal */}
      {reviewTarget && (
        <RideReviewModal
          visible={!!reviewTarget}
          rideId={reviewTarget.rideId}
          driverId={reviewTarget.driverId}
          driverName={reviewTarget.driverName}
          onDismiss={handleReviewDismiss}
        />
      )}

      {/* Driver profile sheet */}
      <DriverProfileSheet
        visible={profileSheetVisible}
        driverId={selectedDriverId}
        onClose={() => {
          setProfileSheetVisible(false);
          setSelectedDriverId(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0D1117" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 56 : 40,
    paddingBottom: 16,
    paddingHorizontal: 16,
    backgroundColor: "#111827",
    borderBottomWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  summaryStrip: {
    flexDirection: "row",
    backgroundColor: "#111827",
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderBottomWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryDivider: { width: 0.5, backgroundColor: "rgba(255,255,255,0.08)" },
  summaryValue: { fontSize: 22, fontWeight: "700", color: "#F1F5F9" },
  summaryLabel: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "#1E2A3A",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
  },
  filterTabActive: { backgroundColor: "#E8500A", borderColor: "#E8500A" },
  filterTabText: { fontSize: 13, fontWeight: "500", color: "#6B7280" },
  filterTabTextActive: { color: "#fff" },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: "#F1F5F9" },
  emptySubtitle: { fontSize: 13, color: "#6B7280", textAlign: "center" },
  list: { flex: 1 },
  rideList: { paddingHorizontal: 16, paddingTop: 4 },
  dayGroup: { gap: 10 },
  daySeparator: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 20,
    marginBottom: 12,
    gap: 10,
  },
  daySeparatorLine: {
    flex: 1,
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  daySeparatorLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#6B7280",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  rideCard: {
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 16,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.07)",
  },
  rideCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  rideTime: { fontSize: 13, fontWeight: "500", color: "#9CA3AF" },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 0.5,
  },
  statusText: { fontSize: 11, fontWeight: "600" },
  otherPartyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  otherParty: { fontSize: 12, color: "#6B7280" },
  otherPartyName: { color: "#94A3B8", fontWeight: "500" },
  viewProfileBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: "rgba(147,197,253,0.08)",
    borderWidth: 0.5,
    borderColor: "rgba(147,197,253,0.2)",
  },
  viewProfileBtnText: { fontSize: 11, fontWeight: "600", color: "#93C5FD" },
  routeWrap: { marginBottom: 12 },
  routeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  routeText: { fontSize: 13, color: "#94A3B8", flex: 1 },
  routeLine: {
    width: 1,
    height: 10,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 3.5,
    marginVertical: 2,
  },
  fareRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
    marginBottom: 10,
  },
  fareLabel: { fontSize: 12, color: "#6B7280" },
  fareAmount: { fontSize: 15, fontWeight: "700", color: "#F1F5F9" },
  reviewSection: {
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.06)",
    paddingTop: 10,
  },
  reviewedRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  starsReadOnly: { flexDirection: "row", gap: 2 },
  reviewedLabel: { fontSize: 12, color: "#6B7280" },
  rateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: "rgba(245,158,11,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(245,158,11,0.3)",
  },
  rateBtnText: { fontSize: 13, fontWeight: "600", color: "#F59E0B" },
  noRatingText: { fontSize: 12, color: "#374151", fontStyle: "italic" },
});
