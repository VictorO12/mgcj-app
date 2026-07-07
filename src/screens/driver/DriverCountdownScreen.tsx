import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from "react-native";

interface ActiveRide {
  id: string;
  scheduled_at: string | null;
  leave_by: string | null;
  pickup_address: string;
  dropoff_address: string;
  passenger_name: string | null;
  fare_estimate: number | null;
  payment_method: string | null;
}

interface Props {
  ride: ActiveRide;
  onStart: () => void;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Halifax",
  });
}

export default function DriverCountdownScreen({ ride, onStart }: Props) {
  const leaveByMs = ride.leave_by ? new Date(ride.leave_by).getTime() : null;
  const isAlreadyLate = leaveByMs !== null && leaveByMs <= Date.now();

  const [msRemaining, setMsRemaining] = useState<number>(
    leaveByMs ? Math.max(0, leaveByMs - Date.now()) : 0
  );
  const [startEnabled, setStartEnabled] = useState(isAlreadyLate || leaveByMs === null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!leaveByMs || startEnabled) return;

    intervalRef.current = setInterval(() => {
      const remaining = leaveByMs - Date.now();
      if (remaining <= 0) {
        setMsRemaining(0);
        setStartEnabled(true);
        clearInterval(intervalRef.current!);
      } else {
        setMsRemaining(remaining);
      }
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [leaveByMs]);

  const pickupTimeLabel = ride.scheduled_at ? formatTime(ride.scheduled_at) : "";
  const leaveByLabel    = ride.leave_by     ? formatTime(ride.leave_by)     : "";
  const fareLabel = ride.fare_estimate
    ? `$${Number(ride.fare_estimate).toFixed(2)}`
    : "Cash";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>

        <Text style={styles.badge}>🗓 SCHEDULED RIDE</Text>

        <Text style={styles.pickupTime}>{pickupTimeLabel} pickup</Text>

        <View style={styles.addressBlock}>
          <Text style={styles.addressLabel}>FROM</Text>
          <Text style={styles.address}>{ride.pickup_address}</Text>
          <Text style={[styles.addressLabel, { marginTop: 8 }]}>TO</Text>
          <Text style={styles.address}>{ride.dropoff_address}</Text>
        </View>

        <View style={styles.meta}>
          {ride.passenger_name && (
            <Text style={styles.metaText}>{ride.passenger_name}</Text>
          )}
          <Text style={styles.metaText}>{fareLabel}</Text>
        </View>

        <View style={styles.divider} />

        {startEnabled ? (
          <View style={styles.startBlock}>
            <Text style={styles.startPrompt}>
              {isAlreadyLate && msRemaining === 0
                ? "Head out now — running tight"
                : "Time to head out"}
            </Text>
            <TouchableOpacity style={styles.startButton} onPress={onStart}>
              <Text style={styles.startButtonText}>On My Way</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.countdownBlock}>
            <Text style={styles.leaveByLabel}>Leave by {leaveByLabel}</Text>
            <Text style={styles.countdown}>{formatCountdown(msRemaining)}</Text>
            <Text style={styles.countdownSub}>until departure</Text>
            <TouchableOpacity
              style={styles.earlyStart}
              onPress={onStart}
            >
              <Text style={styles.earlyStartText}>Leave early</Text>
            </TouchableOpacity>
          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111827",
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
    alignItems: "center",
  },
  badge: {
    color: "#A855F7",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginBottom: 16,
  },
  pickupTime: {
    color: "#F9FAFB",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 24,
  },
  addressBlock: {
    width: "100%",
    backgroundColor: "#1F2937",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  addressLabel: {
    color: "#6B7280",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 4,
  },
  address: {
    color: "#F9FAFB",
    fontSize: 15,
  },
  meta: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 24,
  },
  metaText: {
    color: "#9CA3AF",
    fontSize: 14,
  },
  divider: {
    width: "100%",
    height: 1,
    backgroundColor: "#374151",
    marginBottom: 32,
  },
  // ── Countdown state ──────────────────────────────────────────
  countdownBlock: {
    alignItems: "center",
  },
  leaveByLabel: {
    color: "#9CA3AF",
    fontSize: 15,
    marginBottom: 12,
  },
  countdown: {
    color: "#A855F7",
    fontSize: 64,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -2,
  },
  countdownSub: {
    color: "#6B7280",
    fontSize: 13,
    marginTop: 4,
    marginBottom: 32,
  },
  earlyStart: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#374151",
  },
  earlyStartText: {
    color: "#9CA3AF",
    fontSize: 14,
  },
  // ── Start state ──────────────────────────────────────────────
  startBlock: {
    alignItems: "center",
    gap: 20,
  },
  startPrompt: {
    color: "#9CA3AF",
    fontSize: 16,
  },
  startButton: {
    backgroundColor: "#A855F7",
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 64,
  },
  startButtonText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
  },
});
