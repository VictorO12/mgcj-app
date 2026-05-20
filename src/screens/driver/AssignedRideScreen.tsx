import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";

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

interface Props {
  ride: AssignedRide;
  onAccept: () => void;
  onDecline: () => void;
  onClose: () => void;
}

export default function AssignedRideScreen({
  ride,
  onAccept,
  onDecline,
  onClose,
}: Props) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState<"accept" | "decline" | null>(null);

  const isScheduled = !!ride.scheduled_at;

  function estimateKm(lat1: number, lng1: number, lat2: number, lng2: number) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }

  const tripKm = estimateKm(
    ride.pickup_lat,
    ride.pickup_lng,
    ride.dropoff_lat,
    ride.dropoff_lng,
  );

  async function handleAccept() {
    setLoading("accept");

    // For scheduled rides: only confirm, do NOT change status.
    // The ride stays pending/assigned until it's time — dispatch will activate it.
    // For immediate rides: mark assigned so driver enters the active ride flow.
    const update = isScheduled
      ? { confirmed_by_driver: true }
      : { confirmed_by_driver: true, status: "assigned" };

    const { error } = await supabase
      .from("rides")
      .update(update)
      .eq("id", ride.id)
      .eq("driver_id", profile?.id);

    setLoading(null);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    if (isScheduled) {
      const formatted = new Date(ride.scheduled_at!).toLocaleString("en-CA", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      Alert.alert(
        "Ride confirmed! 🗓",
        `Scheduled for ${formatted}. It will appear in your active rides at that time.`,
        [{ text: "OK", onPress: onAccept }],
      );
    } else {
      onAccept();
    }
  }

  async function handleDecline() {
    Alert.alert(
      "Decline ride?",
      "This ride will be returned to the queue and dispatch will be notified.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Decline",
          style: "destructive",
          onPress: async () => {
            setLoading("decline");
            const { error } = await supabase
              .from("rides")
              .update({ driver_id: null, status: "pending" })
              .eq("id", ride.id)
              .eq("driver_id", profile?.id);
            setLoading(null);
            if (error) {
              Alert.alert("Error", error.message);
              return;
            }
            onDecline();
          },
        },
      ],
    );
  }

  function callPassenger() {
    if (!ride.passenger_phone) return;
    Linking.openURL(`tel:${ride.passenger_phone}`);
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ride assignment</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Status badge */}
      <View style={styles.statusWrap}>
        <View style={styles.statusBadge}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>
            {isScheduled
              ? "🗓 Scheduled ride — confirmation required"
              : "🚗 Immediate ride — confirmation required"}
          </Text>
        </View>
      </View>

      {/* Scheduled time card */}
      {isScheduled && (
        <View style={styles.scheduledCard}>
          <Ionicons name="calendar-outline" size={20} color="#A855F7" />
          <View>
            <Text style={styles.scheduledLabel}>Scheduled for</Text>
            <Text style={styles.scheduledTime}>
              {new Date(ride.scheduled_at!).toLocaleString("en-CA", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </View>
      )}

      {/* Passenger card */}
      <View style={styles.passengerCard}>
        <View style={styles.passengerAvatar}>
          <Text style={styles.passengerInitials}>
            {ride.passenger_name
              ?.split(" ")
              .map((n) => n[0])
              .join("")
              .slice(0, 2)
              .toUpperCase() ?? "?"}
          </Text>
        </View>
        <View style={styles.passengerInfo}>
          <Text style={styles.passengerName}>
            {ride.passenger_name ?? "Passenger"}
          </Text>
          <Text style={styles.passengerSub}>Passenger</Text>
        </View>
        {ride.passenger_phone && (
          <TouchableOpacity style={styles.callBtn} onPress={callPassenger}>
            <Ionicons name="call-outline" size={18} color="#CBD5E1" />
          </TouchableOpacity>
        )}
      </View>

      {/* Route */}
      <View style={styles.routeCard}>
        <View style={styles.routeRow}>
          <View style={[styles.routeDot, { backgroundColor: "#4a9eff" }]} />
          <View style={styles.routeText}>
            <Text style={styles.routeLabel}>Pickup</Text>
            <Text style={styles.routeAddr}>{ride.pickup_address}</Text>
          </View>
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
          <View style={styles.routeText}>
            <Text style={styles.routeLabel}>Drop-off</Text>
            <Text style={styles.routeAddr}>{ride.dropoff_address}</Text>
          </View>
        </View>
      </View>

      {/* Trip stats */}
      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Ionicons name="navigate-outline" size={16} color="#6B7280" />
          <Text style={styles.statValue}>{tripKm} km</Text>
          <Text style={styles.statLabel}>Trip distance</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Ionicons name="cash-outline" size={16} color="#6B7280" />
          <Text style={styles.statValue}>
            ${ride.fare_estimate?.toFixed(2) ?? "--"}
          </Text>
          <Text style={styles.statLabel}>Est. fare</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statBox}>
          <Ionicons
            name={
              ride.payment_method === "card" ? "card-outline" : "cash-outline"
            }
            size={16}
            color="#6B7280"
          />
          <Text style={styles.statValue}>
            {ride.payment_method === "card" ? "Card" : "Cash"}
          </Text>
          <Text style={styles.statLabel}>Payment</Text>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.declineBtn, loading === "decline" && { opacity: 0.6 }]}
          onPress={handleDecline}
          disabled={!!loading}
          activeOpacity={0.8}
        >
          {loading === "decline" ? (
            <ActivityIndicator color="#F87171" />
          ) : (
            <>
              <Ionicons name="close-circle-outline" size={20} color="#F87171" />
              <Text style={styles.declineBtnText}>Decline</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.acceptBtn, loading === "accept" && { opacity: 0.6 }]}
          onPress={handleAccept}
          disabled={!!loading}
          activeOpacity={0.85}
        >
          {loading === "accept" ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons
                name="checkmark-circle-outline"
                size={20}
                color="#fff"
              />
              <Text style={styles.acceptBtnText}>
                {isScheduled ? "Confirm ride" : "Accept ride"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
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

  statusWrap: { paddingHorizontal: 20, marginBottom: 16 },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(245,158,11,0.1)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 0.5,
    borderColor: "rgba(245,158,11,0.25)",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#F59E0B",
  },
  statusText: { fontSize: 13, color: "#F59E0B", fontWeight: "500", flex: 1 },

  scheduledCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: "rgba(168,85,247,0.1)",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(168,85,247,0.25)",
  },
  scheduledLabel: { fontSize: 11, color: "#A855F7", marginBottom: 2 },
  scheduledTime: { fontSize: 15, fontWeight: "600", color: "#F1F5F9" },

  passengerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  passengerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(74,158,255,0.3)",
  },
  passengerInitials: { fontSize: 15, fontWeight: "700", color: "#93C5FD" },
  passengerInfo: { flex: 1 },
  passengerName: { fontSize: 15, fontWeight: "600", color: "#F1F5F9" },
  passengerSub: { fontSize: 12, color: "#6B7280", marginTop: 1 },
  callBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#253D56",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
  },

  routeCard: {
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  routeRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  routeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
    flexShrink: 0,
  },
  routeText: { flex: 1 },
  routeLabel: {
    fontSize: 10,
    color: "#6B7280",
    marginBottom: 2,
    textTransform: "uppercase",
    letterSpacing: 0.05,
  },
  routeAddr: { fontSize: 14, color: "#F1F5F9", lineHeight: 20 },
  routeLineWrap: { paddingLeft: 4, paddingVertical: 4 },
  routeLine: {
    width: 1.5,
    height: 16,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginLeft: 3,
  },

  statsRow: {
    flexDirection: "row",
    marginHorizontal: 20,
    marginBottom: 24,
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  statBox: { flex: 1, alignItems: "center", paddingVertical: 14, gap: 4 },
  statDivider: { width: 0.5, backgroundColor: "rgba(255,255,255,0.08)" },
  statValue: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  statLabel: { fontSize: 11, color: "#6B7280" },

  actions: { flexDirection: "row", gap: 12, paddingHorizontal: 20 },
  declineBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.25)",
  },
  declineBtnText: { color: "#F87171", fontSize: 15, fontWeight: "600" },
  acceptBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: "#1D9E75",
  },
  acceptBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
