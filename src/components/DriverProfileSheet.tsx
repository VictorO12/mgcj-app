import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  ScrollView,
  ActivityIndicator,
  Modal,
  TouchableWithoutFeedback,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/AuthContext";
import ReportDriverModal from "./ReportDriverModal";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  passenger_name: string | null;
  passenger_avatar_url: string | null;
}

interface DriverProfile {
  name: string | null;
  avatar_url: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
  average_rating: number | null;
  review_count: number;
  /** Per-star tallies over ALL reviews, e.g. { "5": 12, "4": 3 }. */
  rating_counts: Record<string, number>;
  /** Most recent 20 only — use review_count/rating_counts for totals. */
  reviews: Review[];
}

interface Props {
  visible: boolean;
  driverId: string | null;
  rideId?: string | null;
  onClose: () => void;
}

function StarRow({
  rating,
  size = 14,
  colors,
}: {
  rating: number;
  size?: number;
  colors: Colors;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Ionicons
          key={s}
          name={s <= Math.round(rating) ? "star" : "star-outline"}
          size={size}
          color={s <= Math.round(rating) ? colors.accentAmber : colors.textFaint}
        />
      ))}
    </View>
  );
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
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

export default function DriverProfileSheet({
  visible,
  driverId,
  rideId = null,
  onClose,
}: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const slideY = useRef(new Animated.Value(700)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [driver, setDriver] = useState<DriverProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [alreadyReported, setAlreadyReported] = useState(false);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideY, {
          toValue: 0,
          useNativeDriver: true,
          tension: 65,
          friction: 12,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, {
          toValue: 700,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  useEffect(() => {
    if (visible && driverId) fetchDriverProfile(driverId);
  }, [visible, driverId]);

  useEffect(() => {
    if (visible && rideId && profile) {
      checkExistingReport(rideId, profile.id);
    } else {
      setAlreadyReported(false);
    }
  }, [visible, rideId, profile]);

  async function checkExistingReport(rideId: string, passengerId: string) {
    const { data } = await supabase
      .from("driver_reports")
      .select("id")
      .eq("ride_id", rideId)
      .eq("passenger_id", passengerId)
      .maybeSingle();

    setAlreadyReported(!!data);
  }

  async function fetchDriverProfile(id: string) {
    setLoading(true);
    setDriver(null);

    // One definer RPC rather than direct table reads: RLS only lets a passenger
    // SELECT a driver's `profiles` row once they've shared a ride, so tapping a
    // driver on the map used to come back with no name, avatar or reviews. The
    // RPC also returns aggregates over every review and folds in the reviewers'
    // names, replacing a query-per-review round trip.
    const { data, error } = await supabase.rpc("driver_public_profile", {
      p_driver_id: id,
    });

    if (error || !data) {
      console.error("[DriverProfileSheet] profile load failed:", error);
      setDriver(null);
      setLoading(false);
      return;
    }

    setDriver({
      name: data.name ?? null,
      avatar_url: data.avatar_url ?? null,
      vehicle_make: data.vehicle_make ?? null,
      vehicle_model: data.vehicle_model ?? null,
      plate_number: data.plate_number ?? null,
      average_rating: data.average_rating != null ? Number(data.average_rating) : null,
      review_count: data.review_count ?? 0,
      rating_counts: data.rating_counts ?? {},
      reviews: (data.reviews ?? []) as Review[],
    });

    setLoading(false);
  }

  function ratingBarPct(star: number) {
    if (!driver || driver.review_count === 0) return 0;
    // Off the full tallies, not the 20 loaded reviews — the bars used to be
    // computed from the page and disagreed with the total next to them.
    const count = driver.rating_counts[String(star)] ?? 0;
    return (count / driver.review_count) * 100;
  }

  function handleReportDismiss(submitted: boolean) {
    setReportVisible(false);
    if (submitted) setAlreadyReported(true);
  }

  const initials = driver?.name
    ? driver.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity }]} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[styles.sheet, { transform: [{ translateY: slideY }] }]}
        >
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>Driver profile</Text>
            <View style={styles.headerActions}>
              {driverId && rideId && (
                <TouchableOpacity
                  style={[
                    styles.reportBtn,
                    alreadyReported && styles.reportBtnDone,
                  ]}
                  onPress={() => !alreadyReported && setReportVisible(true)}
                  disabled={alreadyReported}
                >
                  <Ionicons
                    name={alreadyReported ? "checkmark-circle" : "flag-outline"}
                    size={14}
                    color={alreadyReported ? colors.textSecondary : colors.accentRed}
                  />
                  <Text
                    style={[
                      styles.reportBtnText,
                      alreadyReported && styles.reportBtnTextDone,
                    ]}
                  >
                    {alreadyReported ? "Reported" : "Report"}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {loading ? (
            <View style={styles.centerWrap}>
              <ActivityIndicator color={colors.accentOrange} size="large" />
            </View>
          ) : !driver ? (
            <View style={styles.centerWrap}>
              <Text style={styles.emptyText}>Could not load profile.</Text>
            </View>
          ) : (
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scroll}
            >
              {/* Identity card */}
              <View style={styles.identityCard}>
                {driver.avatar_url ? (
                  <Image
                    source={{ uri: driver.avatar_url }}
                    style={styles.avatarImage}
                  />
                ) : (
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials}</Text>
                  </View>
                )}
                <View style={styles.identityInfo}>
                  <Text style={styles.driverName}>
                    {driver.name ?? "Driver"}
                  </Text>
                  {driver.vehicle_make ? (
                    <Text style={styles.vehicleText}>
                      {driver.vehicle_make} {driver.vehicle_model}
                      {driver.plate_number ? ` · ${driver.plate_number}` : ""}
                    </Text>
                  ) : null}
                  {driver.average_rating !== null && (
                    <View style={styles.ratingPill}>
                      <Ionicons name="star" size={12} color={colors.accentAmber} />
                      <Text style={styles.ratingPillText}>
                        {driver.average_rating.toFixed(1)} ·{" "}
                        {driver.review_count}{" "}
                        {driver.review_count === 1 ? "review" : "reviews"}
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              {/* Rating summary */}
              {driver.review_count === 0 ? (
                <View style={styles.noReviewsCard}>
                  <Ionicons name="star-outline" size={28} color={colors.textFaint} />
                  <Text style={styles.noReviewsTitle}>No reviews yet</Text>
                  <Text style={styles.noReviewsSub}>
                    This driver hasn't received any ratings yet.
                  </Text>
                </View>
              ) : (
                <View style={styles.ratingCard}>
                  <View style={styles.ratingLeft}>
                    <Text style={styles.bigRating}>
                      {driver.average_rating?.toFixed(1)}
                    </Text>
                    <StarRow rating={driver.average_rating ?? 0} size={16} colors={colors} />
                    <Text style={styles.reviewCount}>
                      {driver.review_count}{" "}
                      {driver.review_count === 1 ? "review" : "reviews"}
                    </Text>
                  </View>
                  <View style={styles.bars}>
                    {[5, 4, 3, 2, 1].map((star) => (
                      <View key={star} style={styles.barRow}>
                        <Text style={styles.barLabel}>{star}</Text>
                        <Ionicons name="star" size={9} color={colors.accentAmber} />
                        <View style={styles.barTrack}>
                          <View
                            style={[
                              styles.barFill,
                              { width: `${ratingBarPct(star)}%` as any },
                            ]}
                          />
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {/* Reviews list */}
              {driver.reviews.length > 0 && (
                <View style={styles.reviewsSection}>
                  <Text style={styles.sectionTitle}>Recent reviews</Text>
                  {driver.reviews.map((review) => (
                    <View key={review.id} style={styles.reviewCard}>
                      <View style={styles.reviewHeader}>
                        {review.passenger_avatar_url ? (
                          <Image
                            source={{ uri: review.passenger_avatar_url }}
                            style={styles.reviewAvatarImage}
                          />
                        ) : (
                          <View style={styles.reviewAvatar}>
                            <Text style={styles.reviewAvatarText}>
                              {review.passenger_name
                                ? review.passenger_name[0].toUpperCase()
                                : "?"}
                            </Text>
                          </View>
                        )}
                        <View style={styles.reviewMeta}>
                          <Text style={styles.reviewerName}>
                            {review.passenger_name ?? "Passenger"}
                          </Text>
                          <Text style={styles.reviewDate}>
                            {formatDate(review.created_at)}
                          </Text>
                        </View>
                        <StarRow rating={review.rating} size={12} colors={colors} />
                      </View>
                      {review.comment ? (
                        <Text style={styles.reviewComment}>
                          {review.comment}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}

              <View style={{ height: 40 }} />
            </ScrollView>
          )}
        </Animated.View>
      </View>

      {driverId && rideId && (
        <ReportDriverModal
          visible={reportVisible}
          rideId={rideId}
          driverId={driverId}
          driverName={driver?.name ?? null}
          onDismiss={handleReportDismiss}
        />
      )}
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 0.5,
    borderColor: colors.border,
    maxHeight: "88%",
  },
  handleRow: { alignItems: "center", paddingTop: 12, paddingBottom: 4 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  reportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.25)",
  },
  reportBtnDone: {
    backgroundColor: "rgba(107,114,128,0.1)",
    borderColor: "rgba(107,114,128,0.25)",
  },
  reportBtnText: { fontSize: 12, fontWeight: "600", color: colors.accentRed },
  reportBtnTextDone: { color: colors.textSecondary },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  centerWrap: { paddingVertical: 60, alignItems: "center" },
  emptyText: { fontSize: 14, color: colors.textSecondary },
  scroll: { paddingHorizontal: 20 },

  identityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  avatarImage: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 2,
    borderColor: colors.accentOrange,
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.accentOrange,
  },
  avatarText: { fontSize: 18, fontWeight: "700", color: colors.avatarText },
  identityInfo: { flex: 1, gap: 4 },
  driverName: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
  vehicleText: { fontSize: 13, color: colors.textSecondary },
  ratingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(245,158,11,0.1)",
    borderRadius: 10,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderWidth: 0.5,
    borderColor: "rgba(245,158,11,0.25)",
    alignSelf: "flex-start",
    marginTop: 2,
  },
  ratingPillText: { fontSize: 12, fontWeight: "600", color: colors.accentAmber },

  noReviewsCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  noReviewsTitle: { fontSize: 15, fontWeight: "600", color: colors.textMuted },
  noReviewsSub: { fontSize: 13, color: colors.textTertiary, textAlign: "center" },

  ratingCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  ratingLeft: { alignItems: "center", gap: 4, minWidth: 70 },
  bigRating: {
    fontSize: 42,
    fontWeight: "800",
    color: colors.textPrimary,
    lineHeight: 48,
  },
  reviewCount: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  bars: { flex: 1, gap: 5 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  barLabel: { fontSize: 11, color: colors.textSecondary, width: 10, textAlign: "right" },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.surface,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: colors.accentAmber, borderRadius: 3 },

  reviewsSection: { gap: 10 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 4,
  },
  reviewCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: colors.border,
    gap: 8,
  },
  reviewHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  reviewAvatarImage: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewAvatarText: { fontSize: 11, fontWeight: "700", color: colors.avatarText },
  reviewMeta: { flex: 1 },
  reviewerName: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
  reviewDate: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  reviewComment: { fontSize: 13, color: colors.textTertiary, lineHeight: 19 },
});
