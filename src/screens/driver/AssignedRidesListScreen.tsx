import React, { useState, useEffect, useMemo } from "react";
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
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rides, setRides] = useState<AssignedRide[]>([]);
  const [openRides, setOpenRides] = useState<AssignedRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tab, setTab] = useState<"mine" | "open">("mine");

  useEffect(() => {
    fetchAssignedRides();
    fetchOpenRides();
  }, [profile]);

  // Realtime: keep this list live while it's open (cancellations,
  // reassignments, deletions elsewhere shouldn't require a manual refresh).
  // No server-side filter — a Postgres changes filter only matches against
  // the *new* row, so a reassignment away from this driver (driver_id
  // changing from profile.id to someone else) wouldn't match and we'd miss
  // it. Checking old/new client-side catches both directions.
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("assigned-rides-list-" + profile.id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides" },
        (payload) => {
          const oldRow = payload.old as any;
          const newRow = payload.new as any;
          if (
            oldRow?.driver_id === profile.id ||
            newRow?.driver_id === profile.id
          ) {
            fetchAssignedRides();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  // Pull-based fallback for the push-broadcast offer: a driver who missed
  // or ignored the scheduled-ride notification (offline, stale token, OS
  // killed the app) can still discover and claim it from here. No
  // server-side filter for the same reason as above — claims/escalations
  // change driver_id, so we just refetch on any company-relevant change.
  useEffect(() => {
    if (!profile?.company_id) return;
    const channel = supabase
      .channel("open-scheduled-rides-" + profile.id)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides" },
        (payload) => {
          const oldRow = payload.old as any;
          const newRow = payload.new as any;
          if (
            oldRow?.company_id === profile.company_id ||
            newRow?.company_id === profile.company_id
          ) {
            fetchOpenRides();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  async function fetchOpenRides() {
    if (!profile?.company_id) return;

    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("company_id", profile.company_id)
      .eq("status", "scheduled")
      .is("driver_id", null)
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true });

    if (!data) return;

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
    setOpenRides(enriched);
  }

  async function claimOpenRide(ride: AssignedRide) {
    if (!profile) return;
    setActionLoading(ride.id);
    const { data, error } = await supabase
      .from("rides")
      .update({ driver_id: profile.id, confirmed_by_driver: true })
      .eq("id", ride.id)
      .is("driver_id", null) // race-safe — same guard as the push-claim path
      .eq("status", "scheduled")
      .select("id");
    setActionLoading(null);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    if (!data || data.length === 0) {
      Alert.alert("Already claimed", "Another driver already took this ride.");
      fetchOpenRides();
      return;
    }

    setOpenRides((prev) => prev.filter((r) => r.id !== ride.id));
    fetchAssignedRides();
    Alert.alert(
      "Claimed!",
      "Scheduled ride added to your assigned rides. You'll be notified when it's time to head to pickup.",
    );
  }

  async function fetchAssignedRides() {
    if (!profile) return;

    const graceCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ["offered", "assigned", "scheduled"])
      // ← removed .eq("confirmed_by_driver", false) so confirmed rides stay visible
      .or(`scheduled_at.is.null,scheduled_at.gte.${graceCutoff}`)
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
    const update = isImmediate
      ? { confirmed_by_driver: true, status: "assigned" }
      : { confirmed_by_driver: true };
    const { error } = await supabase
      .from("rides")
      .update(update)
      .eq("id", ride.id)
      .eq("driver_id", profile?.id);
    setActionLoading(null);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    if (isImmediate) {
      setRides((prev) => prev.filter((r) => r.id !== ride.id));
      onAccepted();
      onClose();
    } else {
      // Refresh so card stays but now shows Confirmed badge
      fetchAssignedRides();
      Alert.alert(
        "Confirmed!",
        "Scheduled ride confirmed. You'll be notified when it's time to head to pickup.",
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

  function minutesUntil(scheduledAt: string): number {
    return Math.round((new Date(scheduledAt).getTime() - Date.now()) / 60000);
  }

  function countdownLabel(scheduledAt: string): string {
    const mins = minutesUntil(scheduledAt);
    if (mins <= 0) return "Starting now";
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
  }

  const immediateRides = rides.filter((r) => !r.scheduled_at);
  const scheduledRides = rides.filter((r) => !!r.scheduled_at);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Assigned rides</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === "mine" && styles.tabBtnActive]}
          onPress={() => setTab("mine")}
          activeOpacity={0.8}
        >
          <Text style={[styles.tabBtnText, tab === "mine" && styles.tabBtnTextActive]}>
            My rides{rides.length > 0 ? ` (${rides.length})` : ""}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === "open" && styles.tabBtnActive]}
          onPress={() => setTab("open")}
          activeOpacity={0.8}
        >
          <Text style={[styles.tabBtnText, tab === "open" && styles.tabBtnTextActive]}>
            Available{openRides.length > 0 ? ` (${openRides.length})` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accentOrange} size="large" />
        </View>
      ) : tab === "mine" && rides.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="car-outline" size={48} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>No assigned rides</Text>
          <Text style={styles.emptySub}>
            Dispatch will notify you when a ride is assigned.
          </Text>
        </View>
      ) : tab === "open" && openRides.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="calendar-outline" size={48} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>No open scheduled rides</Text>
          <Text style={styles.emptySub}>
            Everything in the schedule is already claimed.
          </Text>
        </View>
      ) : tab === "mine" ? (
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {immediateRides.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>IMMEDIATE RIDES</Text>
              {hasActiveRide && (
                <View style={styles.warningBanner}>
                  <Ionicons name="warning-outline" size={16} color={colors.accentAmber} />
                  <Text style={styles.warningText}>
                    Complete your current ride before accepting another
                    immediate ride
                  </Text>
                </View>
              )}
              {immediateRides.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  isImmediate
                  blocked={hasActiveRide}
                  actionLoading={actionLoading}
                  countdownLabel={null}
                  onAccept={() => acceptRide(ride)}
                  onDecline={() => declineRide(ride)}
                  onCall={() =>
                    ride.passenger_phone && callPassenger(ride.passenger_phone)
                  }
                />
              ))}
            </>
          )}

          {scheduledRides.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
                SCHEDULED RIDES
              </Text>
              {scheduledRides.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  isImmediate={false}
                  blocked={false}
                  actionLoading={actionLoading}
                  countdownLabel={
                    ride.scheduled_at ? countdownLabel(ride.scheduled_at) : null
                  }
                  onAccept={() => acceptRide(ride)}
                  onDecline={() => declineRide(ride)}
                  onCall={() =>
                    ride.passenger_phone && callPassenger(ride.passenger_phone)
                  }
                />
              ))}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      ) : (
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          <Text style={styles.sectionSub}>
            Nobody's claimed these yet — first to tap wins.
          </Text>
          {openRides.map((ride) => (
            <RideCard
              key={ride.id}
              ride={ride}
              isImmediate={false}
              blocked={false}
              open
              actionLoading={actionLoading}
              countdownLabel={
                ride.scheduled_at ? countdownLabel(ride.scheduled_at) : null
              }
              onAccept={() => claimOpenRide(ride)}
              onDecline={() => {}}
              onCall={() =>
                ride.passenger_phone && callPassenger(ride.passenger_phone)
              }
            />
          ))}
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
  open = false,
  actionLoading,
  countdownLabel,
  onAccept,
  onDecline,
  onCall,
}: {
  ride: AssignedRide;
  isImmediate: boolean;
  blocked: boolean;
  open?: boolean;
  actionLoading: string | null;
  countdownLabel: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onCall: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isAccepting = actionLoading === ride.id;
  const isDeclining = actionLoading === ride.id + "-decline";

  function countdownColor(): string {
    if (!ride.scheduled_at) return colors.accentPurple;
    const mins = Math.round(
      (new Date(ride.scheduled_at).getTime() - Date.now()) / 60000,
    );
    if (mins <= 15) return colors.accentRedAlarm;
    if (mins <= 30) return colors.accentAmber;
    return colors.accentPurple;
  }

  return (
    <View
      style={[
        styles.rideCard,
        // Green border tint on confirmed cards so they stand out
        ride.confirmed_by_driver && { borderColor: "rgba(29,158,117,0.3)" },
      ]}
    >
      {/* Top row — type badge + confirmed badge + call button */}
      <View style={styles.rideCardTop}>
        <View style={styles.rideCardTopLeft}>
          <View
            style={[
              styles.typeBadge,
              !isImmediate && styles.typeBadgeScheduled,
            ]}
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

          {/* ← Confirmed badge — only shows after driver accepts */}
          {ride.confirmed_by_driver && (
            <View style={styles.confirmedBadge}>
              <Ionicons name="checkmark-circle" size={12} color={colors.accentGreen} />
              <Text style={styles.confirmedBadgeText}>Confirmed</Text>
            </View>
          )}
        </View>

        {ride.passenger_phone && (
          <TouchableOpacity style={styles.callBtn} onPress={onCall}>
            <Ionicons name="call-outline" size={15} color={colors.textOnSurfaceLight} />
          </TouchableOpacity>
        )}
      </View>

      {/* Scheduled time + countdown */}
      {ride.scheduled_at && (
        <View style={styles.scheduledRow}>
          <Ionicons name="calendar-outline" size={13} color={colors.accentPurple} />
          <Text style={styles.scheduledText}>
            {new Date(ride.scheduled_at).toLocaleString("en-CA", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </Text>
          {countdownLabel && (
            <View
              style={[
                styles.countdownPill,
                {
                  backgroundColor: `${countdownColor()}20`,
                  borderColor: `${countdownColor()}50`,
                },
              ]}
            >
              <Text style={[styles.countdownText, { color: countdownColor() }]}>
                {countdownLabel}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Passenger */}
      <Text style={styles.passengerName}>
        {ride.passenger_name ?? "Passenger"}
      </Text>

      {/* Route */}
      <View style={styles.route}>
        <View style={styles.routeRow}>
          <View style={[styles.dot, { backgroundColor: colors.accentBlue }]} />
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
              { backgroundColor: colors.accentOrange, borderRadius: 3 },
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

      {/* Actions */}
      <View style={styles.actions}>
        {/* Only show Decline on unconfirmed, already-assigned rides — an
            open-board card has nothing assigned to decline */}
        {!open && !ride.confirmed_by_driver && (
          <TouchableOpacity
            style={[styles.declineBtn, isDeclining && { opacity: 0.6 }]}
            onPress={onDecline}
            disabled={!!actionLoading}
            activeOpacity={0.8}
          >
            {isDeclining ? (
              <ActivityIndicator color={colors.accentRed} size="small" />
            ) : (
              <Text style={styles.declineBtnText}>Decline</Text>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[
            styles.acceptBtn,
            ride.confirmed_by_driver && styles.acceptBtnConfirmed,
            (blocked || isAccepting) && { opacity: 0.5 },
          ]}
          onPress={onAccept}
          disabled={!!actionLoading || blocked || ride.confirmed_by_driver}
          activeOpacity={0.85}
        >
          {isAccepting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.acceptBtnText}>
              {blocked
                ? "Ride in progress"
                : ride.confirmed_by_driver
                  ? "✓ Confirmed"
                  : open
                    ? "Claim"
                    : "Accept"}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
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
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
    tabBar: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 20,
      paddingBottom: 14,
    },
    tabBtn: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    tabBtnActive: {
      backgroundColor: "rgba(232,80,10,0.15)",
      borderColor: "rgba(232,80,10,0.35)",
    },
    tabBtnText: { fontSize: 13, fontWeight: "600", color: colors.textSecondary },
    tabBtnTextActive: { color: colors.accentOrange },
    loadingWrap: { paddingTop: 60, alignItems: "center" },
    emptyWrap: { paddingTop: 60, alignItems: "center", gap: 10 },
    emptyTitle: { fontSize: 18, fontWeight: "600", color: colors.textMuted },
    emptySub: {
      fontSize: 13,
      color: colors.textFaint,
      textAlign: "center",
      paddingHorizontal: 40,
    },
    list: { flex: 1, paddingHorizontal: 16 },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
      letterSpacing: 0.8,
      marginBottom: 8,
      marginTop: 4,
    },
    sectionSub: {
      fontSize: 12,
      color: colors.textFaint,
      marginBottom: 10,
      marginTop: -4,
    },
    warningBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: "rgba(245,158,11,0.1)",
      borderRadius: 10,
      padding: 12,
      marginBottom: 10,
      borderWidth: 0.5,
      borderColor: "rgba(245,158,11,0.25)",
    },
    warningText: { fontSize: 13, color: colors.accentAmber, flex: 1 },
    rideCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    rideCardTop: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10,
    },
    rideCardTopLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flex: 1,
    },
    typeBadge: {
      backgroundColor: "rgba(232,80,10,0.15)",
      borderRadius: 20,
      paddingVertical: 3,
      paddingHorizontal: 10,
      borderWidth: 0.5,
      borderColor: "rgba(232,80,10,0.3)",
    },
    typeBadgeScheduled: {
      backgroundColor: "rgba(168,85,247,0.15)",
      borderColor: "rgba(168,85,247,0.3)",
    },
    typeBadgeText: { fontSize: 11, fontWeight: "600", color: colors.accentOrange },
    typeBadgeTextScheduled: { color: colors.accentPurple },
    confirmedBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: "rgba(29,158,117,0.12)",
      borderRadius: 20,
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.3)",
    },
    confirmedBadgeText: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.accentGreen,
    },
    callBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surfaceAlt,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 0.5,
      borderColor: colors.borderStrong,
    },
    scheduledRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 8,
    },
    scheduledText: {
      fontSize: 12,
      color: colors.accentPurple,
      fontWeight: "500",
    },
    countdownPill: {
      borderRadius: 20,
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderWidth: 0.5,
      marginLeft: 4,
    },
    countdownText: { fontSize: 11, fontWeight: "700" },
    passengerName: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.textPrimary,
      marginBottom: 10,
    },
    route: { marginBottom: 10 },
    routeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    routeText: { fontSize: 13, color: colors.textOnSurfaceLight, flex: 1 },
    routeLineWrap: { paddingLeft: 3, paddingVertical: 2 },
    routeLine: {
      width: 1.5,
      height: 12,
      backgroundColor: colors.borderStrong,
      marginLeft: 3,
    },
    fareText: { fontSize: 13, color: colors.textSecondary, marginBottom: 12 },
    actions: { flexDirection: "row", gap: 10 },
    declineBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 13,
      borderRadius: 12,
      backgroundColor: "rgba(248,113,113,0.1)",
      borderWidth: 0.5,
      borderColor: "rgba(248,113,113,0.25)",
    },
    declineBtnText: {
      color: colors.accentRed,
      fontSize: 14,
      fontWeight: "600",
    },
    acceptBtn: {
      flex: 2,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 13,
      borderRadius: 12,
      backgroundColor: colors.accentGreen,
    },
    acceptBtnConfirmed: {
      backgroundColor: "rgba(29,158,117,0.15)",
      borderWidth: 0.5,
      borderColor: "rgba(29,158,117,0.3)",
    },
    acceptBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  });
