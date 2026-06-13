import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  PanResponder,
  Dimensions,
  Platform,
  Linking,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ActiveRide } from "../hooks/useActiveRide";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/AuthContext";
import DriverProfileSheet from "./DriverProfileSheet";
import ReportDriverModal from "./ReportDriverModal";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

interface Props {
  ride: ActiveRide;
  eta: number | null;
  statusLabel: string;
  onCancel: () => void;
  activeDrivers: any[];
}

export default function RideTrackingSheet({
  ride,
  eta,
  statusLabel,
  onCancel,
}: Props) {
  const { profile } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [driverProfileVisible, setDriverProfileVisible] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [alreadyReported, setAlreadyReported] = useState(false);
  const sheetY = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
      onPanResponderRelease: (_, g) => {
        if (g.dy < -40) expand();
        else if (g.dy > 40) collapse();
      },
    }),
  ).current;

  useEffect(() => {
    if (ride?.id && profile) {
      checkExistingReport(ride.id, profile.id);
    }
  }, [ride?.id, profile]);

  async function checkExistingReport(rideId: string, passengerId: string) {
    const { data } = await supabase
      .from("driver_reports")
      .select("id")
      .eq("ride_id", rideId)
      .eq("passenger_id", passengerId)
      .maybeSingle();

    setAlreadyReported(!!data);
  }

  function handleReportDismiss(submitted: boolean) {
    setReportVisible(false);
    if (submitted) setAlreadyReported(true);
  }

  function expand() {
    setExpanded(true);
    Animated.spring(sheetY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }

  function collapse() {
    setExpanded(false);
    Animated.spring(sheetY, { toValue: 0, useNativeDriver: true }).start();
  }

  function callDriver() {
    const phone = ride.driver?.phone;
    if (!phone) return;
    Linking.openURL(`tel:${phone}`);
  }

  function smsDriver() {
    const phone = ride.driver?.phone;
    if (!phone) return;
    Linking.openURL(`sms:${phone}`);
  }

  function handleCancel() {
    const isEnRoute =
      ride.status === "assigned" || ride.status === "driver_arriving";

    const title = isEnRoute ? "Cancel ride?" : "Cancel ride?";
    const message = isEnRoute
      ? "Your driver is already on the way. Are you sure you want to cancel?"
      : "Are you sure you want to cancel this ride?";

    Alert.alert(title, message, [
      { text: "No", style: "cancel" },
      { text: "Yes, cancel", style: "destructive", onPress: onCancel },
    ]);
  }

  const isCompleted = ride.status === "completed";
  const isCancelled = ride.status === "cancelled";
  const isPending = ride.status === "pending";
  const isInProgress = ride.status === "in_progress";
  const hasDriver = !!ride.driver;

  const statusColor = isCompleted
    ? "#1D9E75"
    : isCancelled
      ? "#E24B4A"
      : isPending
        ? "#F59E0B"
        : "#E8500A";

  const driverInitials =
    ride.driver?.name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2) ?? "D";

  // ── MINIMIZED BAR ──────────────────────────────────────────
  if (!expanded) {
    return (
      <TouchableOpacity
        style={styles.miniBar}
        onPress={expand}
        activeOpacity={0.92}
        {...panResponder.panHandlers}
      >
        <View style={styles.miniLeft}>
          <View style={[styles.pulseDot, { backgroundColor: statusColor }]} />
          <View>
            <Text style={styles.miniStatus}>{statusLabel}</Text>
            <Text style={styles.miniSub}>
              {eta !== null ? `${eta} min away` : "Calculating…"}
              {hasDriver ? ` · ${ride.driver!.name?.split(" ")[0]}` : ""}
            </Text>
          </View>
        </View>
        <View style={styles.miniRight}>
          <Text style={styles.miniEta}>{eta !== null ? `${eta}` : "--"}</Text>
          <Text style={styles.miniEtaLabel}>min</Text>
          <Ionicons
            name="chevron-up"
            size={16}
            color="#6B7280"
            style={{ marginLeft: 8 }}
          />
        </View>
      </TouchableOpacity>
    );
  }

  // ── EXPANDED SHEET ─────────────────────────────────────────
  return (
    <>
      <Animated.View
        style={[styles.fullSheet, { transform: [{ translateY: sheetY }] }]}
      >
        {/* Drag handle */}
        <View style={styles.dragHandle} {...panResponder.panHandlers}>
          <View style={styles.handleBar} />
        </View>

        {/* Status row */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
          <TouchableOpacity onPress={collapse} style={styles.collapseBtn}>
            <Ionicons name="chevron-down" size={20} color="#6B7280" />
          </TouchableOpacity>
        </View>

        {/* ETA banner */}
        <View style={styles.etaBanner}>
          <View>
            <Text style={styles.etaNum}>
              {eta !== null ? `${eta} min` : "—"}
            </Text>
            <Text style={styles.etaLabel}>
              {isInProgress ? "to destination" : "until pickup"}
            </Text>
          </View>
          <View style={styles.routeSummary}>
            <Text style={styles.routeAddr} numberOfLines={1}>
              {ride.pickup_address}
            </Text>
            <Ionicons name="arrow-forward" size={12} color="#4B5563" />
            <Text style={styles.routeAddr} numberOfLines={1}>
              {ride.dropoff_address}
            </Text>
          </View>
        </View>

        {/* Driver card — tappable → profile sheet */}
        {hasDriver && (
          <TouchableOpacity
            style={styles.driverCard}
            onPress={() => setDriverProfileVisible(true)}
            activeOpacity={0.8}
          >
            <View style={styles.driverAvatar}>
              <Text style={styles.driverInitials}>{driverInitials}</Text>
            </View>
            <View style={styles.driverInfo}>
              <Text style={styles.driverName}>
                {ride.driver!.name ?? "Your driver"}
              </Text>
              <Text style={styles.driverVehicle}>
                {ride.driver!.vehicle_make} {ride.driver!.vehicle_model} ·{" "}
                {ride.driver!.plate_number}
              </Text>
              <View style={styles.viewProfileRow}>
                <Text style={styles.viewProfileText}>View profile</Text>
                <Ionicons name="chevron-forward" size={12} color="#6B7280" />
              </View>
            </View>
            <View style={styles.driverActions}>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={(e) => {
                  e.stopPropagation?.();
                  smsDriver();
                }}
              >
                <Ionicons name="chatbubble-outline" size={18} color="#CBD5E1" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={(e) => {
                  e.stopPropagation?.();
                  callDriver();
                }}
              >
                <Ionicons name="call-outline" size={18} color="#CBD5E1" />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}

        {/* Fare + actions */}
        <View style={styles.bottomRow}>
          <View>
            <Text style={styles.fareLabel}>Estimated fare</Text>
            <Text style={styles.fareAmt}>
              $
              {ride.fare_final?.toFixed(2) ??
                ride.fare_estimate?.toFixed(2) ??
                "--"}
            </Text>
          </View>

          {/* Cancel button logic:
              - in_progress: hidden entirely
              - assigned / driver_arriving: visible with stronger warning
              - pending: visible with standard warning
              - completed / cancelled: show completed badge or nothing */}
          {isInProgress || isCompleted || isCancelled ? (
            isCompleted ? (
              <View style={styles.completedBadge}>
                <Ionicons name="checkmark-circle" size={16} color="#1D9E75" />
                <Text style={styles.completedText}>Trip complete</Text>
              </View>
            ) : null
          ) : (
            <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
              <Text style={styles.cancelText}>Cancel ride</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Report driver — prominent, full width */}
        {hasDriver && (
          <TouchableOpacity
            style={[styles.reportRow, alreadyReported && styles.reportRowDone]}
            onPress={() => !alreadyReported && setReportVisible(true)}
            disabled={alreadyReported}
            activeOpacity={0.8}
          >
            <Ionicons
              name={alreadyReported ? "checkmark-circle" : "flag-outline"}
              size={18}
              color={alreadyReported ? "#6B7280" : "#F87171"}
            />
            <Text
              style={[
                styles.reportRowText,
                alreadyReported && styles.reportRowTextDone,
              ]}
            >
              {alreadyReported ? "Reported" : "Report driver"}
            </Text>
          </TouchableOpacity>
        )}
      </Animated.View>

      <DriverProfileSheet
        visible={driverProfileVisible}
        driverId={ride.driver?.id ?? null}
        rideId={ride.id}
        onClose={() => setDriverProfileVisible(false)}
      />

      {ride.driver && (
        <ReportDriverModal
          visible={reportVisible}
          rideId={ride.id}
          driverId={ride.driver.id}
          driverName={ride.driver.name ?? null}
          onDismiss={handleReportDismiss}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  miniBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    backgroundColor: "#1E2A3A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    justifyContent: "space-between",
  },
  miniLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  pulseDot: { width: 10, height: 10, borderRadius: 5 },
  miniStatus: { fontSize: 14, fontWeight: "600", color: "#F1F5F9" },
  miniSub: { fontSize: 12, color: "#6B7280", marginTop: 1 },
  miniRight: { flexDirection: "row", alignItems: "baseline", gap: 2 },
  miniEta: { fontSize: 24, fontWeight: "700", color: "#F1F5F9" },
  miniEtaLabel: { fontSize: 12, color: "#6B7280" },

  fullSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#111827",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === "ios" ? 36 : 24,
  },
  dragHandle: { alignItems: "center", paddingTop: 10, paddingBottom: 6 },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.15)",
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 16, fontWeight: "600", color: "#F1F5F9", flex: 1 },
  collapseBtn: { padding: 4 },

  etaBanner: {
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  etaNum: { fontSize: 28, fontWeight: "700", color: "#F1F5F9" },
  etaLabel: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  routeSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
    marginLeft: 16,
  },
  routeAddr: { fontSize: 11, color: "#6B7280", flex: 1 },

  driverCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  driverAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#E8500A",
  },
  driverInitials: { fontSize: 15, fontWeight: "700", color: "#93C5FD" },
  driverInfo: { flex: 1 },
  driverName: { fontSize: 15, fontWeight: "600", color: "#F1F5F9" },
  driverVehicle: { fontSize: 12, color: "#6B7280", marginTop: 2 },
  viewProfileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 4,
  },
  viewProfileText: { fontSize: 11, color: "#6B7280" },
  driverActions: { flexDirection: "row", gap: 8 },
  actionBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#253D56",
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },

  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.25)",
  },
  reportRowDone: {
    backgroundColor: "rgba(107,114,128,0.08)",
    borderColor: "rgba(107,114,128,0.2)",
  },
  reportRowText: { fontSize: 14, fontWeight: "600", color: "#F87171" },
  reportRowTextDone: { color: "#6B7280" },

  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fareLabel: { fontSize: 12, color: "#6B7280" },
  fareAmt: { fontSize: 22, fontWeight: "700", color: "#F1F5F9" },
  cancelBtn: {
    backgroundColor: "rgba(226,75,74,0.12)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderWidth: 0.5,
    borderColor: "rgba(226,75,74,0.3)",
  },
  cancelText: { color: "#F87171", fontSize: 13, fontWeight: "500" },
  completedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(29,158,117,0.12)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.3)",
  },
  completedText: { color: "#1D9E75", fontSize: 13, fontWeight: "500" },
});
