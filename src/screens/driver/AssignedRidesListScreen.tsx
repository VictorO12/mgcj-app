import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

interface AssignedRide {
  id: string;
  status: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  scheduled_at: string | null;
  confirmed_by_driver: boolean;
  passenger_name: string | null;
  passenger_phone: string | null;
}

interface Props {
  onClose: () => void;
  hasActiveRide: boolean;
  onAccepted: () => void;
}

export default function AssignedRidesListScreen({
  onClose,
  hasActiveRide,
  onAccepted,
}: Props) {
  const { profile } = useAuth();
  const [rides, setRides] = useState<AssignedRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchAssignedRides();
  }, [profile]);

  async function fetchAssignedRides() {
    if (!profile) return;
    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ["assigned", "scheduled"])
      .order("scheduled_at", { ascending: true, nullsFirst: false });
    if (!data) {
      setLoading(false);
      return;
    }

    const enriched = await Promise.all(
      data.map(async (ride) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name, phone")
          .eq("id", ride.passenger_id)
          .single();
        return {
          ...ride,
          passenger_name: p?.name ?? null,
          passenger_phone: p?.phone ?? null,
        };
      }),
    );
    setRides(enriched);
    setLoading(false);
  }

  async function acceptRide(ride: AssignedRide) {
    const isImmediate = !ride.scheduled_at;

    if (isImmediate && hasActiveRide) {
      Alert.alert(
        "Cannot accept",
        "You already have an active ride in progress. Complete it before accepting another immediate ride.",
        [{ text: "OK" }],
      );
      return;
    }

    setActionLoading(ride.id);
    const { error } = await supabase
      .from("rides")
      .update({ confirmed_by_driver: true })
      .eq("id", ride.id)
      .eq("driver_id", profile?.id);
    setActionLoading(null);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    // Move ride to confirmed instead of removing it
    setRides((prev) =>
      prev.map((r) =>
        r.id === ride.id ? { ...r, confirmed_by_driver: true } : r,
      ),
    );

    if (isImmediate) {
      onAccepted();
      onClose();
    } else {
      Alert.alert(
        "Confirmed!",
        "Scheduled ride confirmed. It will appear in your active rides at the scheduled time.",
      );
    }
  }

  async function declineRide(ride: AssignedRide) {
    Alert.alert("Decline ride?", "This ride will be returned to the queue.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Decline",
        style: "destructive",
        onPress: async () => {
          setActionLoading(ride.id + "-decline");
          await supabase
            .from("rides")
            .update({ driver_id: null, status: "pending" })
            .eq("id", ride.id)
            .eq("driver_id", profile?.id);
          setActionLoading(null);
          setRides((prev) => prev.filter((r) => r.id !== ride.id));
        },
      },
    ]);
  }

  function callPassenger(phone: string) {
    Linking.openURL(`tel:${phone}`);
  }

  // Computed after rides is set — in render scope, not inside fetchAssignedRides
  const pendingRides = rides.filter(
    (r) => !r.confirmed_by_driver && !r.scheduled_at,
  );
  const pendingScheduled = rides.filter(
    (r) => !r.confirmed_by_driver && !!r.scheduled_at,
  );
  const confirmedScheduled = rides.filter(
    (r) => r.confirmed_by_driver && !!r.scheduled_at,
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Assigned rides</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#E8500A" size="large" />
        </View>
      ) : rides.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="car-outline" size={48} color="#374151" />
          <Text style={styles.emptyTitle}>No assigned rides</Text>
          <Text style={styles.emptySub}>
            Dispatch will notify you when a ride is assigned.
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {/* Immediate — awaiting response */}
          {pendingRides.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>
                IMMEDIATE — AWAITING RESPONSE
              </Text>
              {hasActiveRide && (
                <View style={styles.warningBanner}>
                  <Ionicons name="warning-outline" size={16} color="#F59E0B" />
                  <Text style={styles.warningText}>
                    Complete your current ride before accepting another
                    immediate ride
                  </Text>
                </View>
              )}
              {pendingRides.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  isImmediate
                  blocked={hasActiveRide}
                  actionLoading={actionLoading}
                  showActions={true}
                  onAccept={() => acceptRide(ride)}
                  onDecline={() => declineRide(ride)}
                  onCall={() =>
                    ride.passenger_phone && callPassenger(ride.passenger_phone)
                  }
                />
              ))}
            </>
          )}

          {/* Scheduled — awaiting response */}
          {pendingScheduled.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
                SCHEDULED — AWAITING RESPONSE
              </Text>
              {pendingScheduled.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  isImmediate={false}
                  blocked={false}
                  actionLoading={actionLoading}
                  showActions={true}
                  onAccept={() => acceptRide(ride)}
                  onDecline={() => declineRide(ride)}
                  onCall={() =>
                    ride.passenger_phone && callPassenger(ride.passenger_phone)
                  }
                />
              ))}
            </>
          )}

          {/* Confirmed scheduled */}
          {confirmedScheduled.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
                CONFIRMED SCHEDULED
              </Text>
              {confirmedScheduled.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  isImmediate={false}
                  blocked={false}
                  actionLoading={actionLoading}
                  showActions={false}
                  onAccept={() => {}}
                  onDecline={() => {}}
                  onCall={() =>
                    ride.passenger_phone && callPassenger(ride.passenger_phone)
                  }
                />
              ))}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

function RideCard({
  ride,
  isImmediate,
  blocked,
  actionLoading,
  onAccept,
  onDecline,
  onCall,
  showActions,
}: {
  ride: AssignedRide;
  isImmediate: boolean;
  blocked: boolean;
  actionLoading: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onCall: () => void;
  showActions: boolean;
}) {
  const isAccepting = actionLoading === ride.id;
  const isDeclining = actionLoading === ride.id + "-decline";

  return (
    <View style={styles.rideCard}>
      {/* Top row */}
      <View style={styles.rideCardTop}>
        <View
          style={[styles.typeBadge, !isImmediate && styles.typeBadgeScheduled]}
        >
          <Text
            style={[
              styles.typeBadgeText,
              !isImmediate && styles.typeBadgeTextScheduled,
            ]}
          >
            {isImmediate ? "Immediate" : "Scheduled"}
          </Text>
        </View>
        {ride.passenger_phone && (
          <TouchableOpacity style={styles.callBtn} onPress={onCall}>
            <Ionicons name="call-outline" size={15} color="#CBD5E1" />
          </TouchableOpacity>
        )}
      </View>

      {/* Scheduled time */}
      {ride.scheduled_at && (
        <View style={styles.scheduledRow}>
          <Ionicons name="calendar-outline" size={13} color="#A855F7" />
          <Text style={styles.scheduledText}>
            {new Date(ride.scheduled_at).toLocaleString("en-CA", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </Text>
        </View>
      )}

      {/* Passenger */}
      <Text style={styles.passengerName}>
        {ride.passenger_name ?? "Passenger"}
      </Text>

      {/* Route */}
      <View style={styles.route}>
        <View style={styles.routeRow}>
          <View style={[styles.dot, { backgroundColor: "#4a9eff" }]} />
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

      {ride.fare_estimate && (
        <Text style={styles.fareText}>
          Est. fare: ${ride.fare_estimate.toFixed(2)}
        </Text>
      )}

      {/* Actions or confirmed badge */}
      {showActions ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.declineBtn, isDeclining && { opacity: 0.6 }]}
            onPress={onDecline}
            disabled={!!actionLoading}
            activeOpacity={0.8}
          >
            {isDeclining ? (
              <ActivityIndicator color="#F87171" size="small" />
            ) : (
              <Text style={styles.declineBtnText}>Decline</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.acceptBtn,
              (blocked || isAccepting) && { opacity: 0.5 },
            ]}
            onPress={onAccept}
            disabled={!!actionLoading || blocked}
            activeOpacity={0.85}
          >
            {isAccepting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.acceptBtnText}>
                {blocked ? "Ride in progress" : "Accept"}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.confirmedBadge}>
          <Ionicons name="checkmark-circle" size={14} color="#1D9E75" />
          <Text style={styles.confirmedBadgeText}>Confirmed</Text>
        </View>
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
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: "#4B5563" },
  emptySub: {
    fontSize: 13,
    color: "#374151",
    textAlign: "center",
    paddingHorizontal: 40,
  },
  list: { flex: 1, paddingHorizontal: 20 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: "#4B5563",
    letterSpacing: 0.08,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(245,158,11,0.08)",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    borderWidth: 0.5,
    borderColor: "rgba(245,158,11,0.2)",
  },
  warningText: { fontSize: 12, color: "#F59E0B", flex: 1, lineHeight: 16 },
  rideCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  rideCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  typeBadge: {
    backgroundColor: "rgba(232,80,10,0.12)",
    borderRadius: 20,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.25)",
  },
  typeBadgeScheduled: {
    backgroundColor: "rgba(168,85,247,0.12)",
    borderColor: "rgba(168,85,247,0.25)",
  },
  typeBadgeText: { fontSize: 11, fontWeight: "600", color: "#E8500A" },
  typeBadgeTextScheduled: { color: "#A855F7" },
  callBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#253D56",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },
  scheduledRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  scheduledText: { fontSize: 12, color: "#A855F7" },
  passengerName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F1F5F9",
    marginBottom: 8,
  },
  route: { marginBottom: 8 },
  routeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  routeText: { fontSize: 12, color: "#9CA3AF", flex: 1 },
  routeLineWrap: { paddingLeft: 3, paddingVertical: 2 },
  routeLine: {
    width: 1.5,
    height: 10,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 2,
  },
  fareText: { fontSize: 12, color: "#6B7280", marginBottom: 10 },
  actions: { flexDirection: "row", gap: 8 },
  declineBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.25)",
    alignItems: "center",
  },
  declineBtnText: { color: "#F87171", fontSize: 13, fontWeight: "600" },
  acceptBtn: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#1D9E75",
    alignItems: "center",
  },
  acceptBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  confirmedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    backgroundColor: "rgba(29,158,117,0.1)",
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.25)",
    marginTop: 8,
  },
  confirmedBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#1D9E75",
  },
});
