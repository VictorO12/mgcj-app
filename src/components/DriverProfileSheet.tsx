import React, { useState, useEffect, useRef } from "react";
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

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  passenger_name: string | null;
}

interface DriverProfile {
  name: string | null;
  avatar_url: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
  average_rating: number | null;
  review_count: number;
  reviews: Review[];
}

interface Props {
  visible: boolean;
  driverId: string | null;
  onClose: () => void;
}

function StarRow({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Ionicons
          key={s}
          name={s <= Math.round(rating) ? "star" : "star-outline"}
          size={size}
          color={s <= Math.round(rating) ? "#F59E0B" : "#374151"}
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
  onClose,
}: Props) {
  const slideY = useRef(new Animated.Value(700)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [driver, setDriver] = useState<DriverProfile | null>(null);
  const [loading, setLoading] = useState(false);

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

  async function fetchDriverProfile(id: string) {
    setLoading(true);
    setDriver(null);

    const [profileRes, vehicleRes, reviewsRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("name, avatar_url")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("drivers")
        .select("vehicle_make, vehicle_model, plate_number")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("ride_reviews")
        .select("id, rating, comment, created_at, passenger_id")
        .eq("driver_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    const rawReviews = reviewsRes.data ?? [];

    const enrichedReviews: Review[] = await Promise.all(
      rawReviews.map(async (r) => {
        let passengerName: string | null = null;
        if (r.passenger_id) {
          const { data: p } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", r.passenger_id)
            .maybeSingle();
          passengerName = p?.name ?? null;
        }
        return {
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          created_at: r.created_at,
          passenger_name: passengerName,
        };
      }),
    );

    const avgRating =
      enrichedReviews.length > 0
        ? enrichedReviews.reduce((sum, r) => sum + r.rating, 0) /
          enrichedReviews.length
        : null;

    setDriver({
      name: profileRes.data?.name ?? null,
      avatar_url: profileRes.data?.avatar_url ?? null,
      vehicle_make: vehicleRes.data?.vehicle_make ?? null,
      vehicle_model: vehicleRes.data?.vehicle_model ?? null,
      plate_number: vehicleRes.data?.plate_number ?? null,
      average_rating: avgRating ? Math.round(avgRating * 10) / 10 : null,
      review_count: enrichedReviews.length,
      reviews: enrichedReviews,
    });

    setLoading(false);
  }

  function ratingBarPct(star: number) {
    if (!driver || driver.review_count === 0) return 0;
    const count = driver.reviews.filter((r) => r.rating === star).length;
    return (count / driver.review_count) * 100;
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
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={18} color="#6B7280" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.centerWrap}>
              <ActivityIndicator color="#E8500A" size="large" />
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
                      <Ionicons name="star" size={12} color="#F59E0B" />
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
                  <Ionicons name="star-outline" size={28} color="#374151" />
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
                    <StarRow rating={driver.average_rating ?? 0} size={16} />
                    <Text style={styles.reviewCount}>
                      {driver.review_count}{" "}
                      {driver.review_count === 1 ? "review" : "reviews"}
                    </Text>
                  </View>
                  <View style={styles.bars}>
                    {[5, 4, 3, 2, 1].map((star) => (
                      <View key={star} style={styles.barRow}>
                        <Text style={styles.barLabel}>{star}</Text>
                        <Ionicons name="star" size={9} color="#F59E0B" />
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
                        <View style={styles.reviewAvatar}>
                          <Text style={styles.reviewAvatarText}>
                            {review.passenger_name
                              ? review.passenger_name[0].toUpperCase()
                              : "?"}
                          </Text>
                        </View>
                        <View style={styles.reviewMeta}>
                          <Text style={styles.reviewerName}>
                            {review.passenger_name ?? "Passenger"}
                          </Text>
                          <Text style={styles.reviewDate}>
                            {formatDate(review.created_at)}
                          </Text>
                        </View>
                        <StarRow rating={review.rating} size={12} />
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: "#111827",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
    maxHeight: "88%",
  },
  handleRow: { alignItems: "center", paddingTop: 12, paddingBottom: 4 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
  },
  centerWrap: { paddingVertical: 60, alignItems: "center" },
  emptyText: { fontSize: 14, color: "#6B7280" },
  scroll: { paddingHorizontal: 20 },

  identityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  avatarImage: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 2,
    borderColor: "#E8500A",
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#1E3A5F",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#E8500A",
  },
  avatarText: { fontSize: 18, fontWeight: "700", color: "#93C5FD" },
  identityInfo: { flex: 1, gap: 4 },
  driverName: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  vehicleText: { fontSize: 13, color: "#6B7280" },
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
  ratingPillText: { fontSize: 12, fontWeight: "600", color: "#F59E0B" },

  noReviewsCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  noReviewsTitle: { fontSize: 15, fontWeight: "600", color: "#4B5563" },
  noReviewsSub: { fontSize: 13, color: "#374151", textAlign: "center" },

  ratingCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 20,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  ratingLeft: { alignItems: "center", gap: 4, minWidth: 70 },
  bigRating: {
    fontSize: 42,
    fontWeight: "800",
    color: "#F1F5F9",
    lineHeight: 48,
  },
  reviewCount: { fontSize: 11, color: "#6B7280", marginTop: 2 },
  bars: { flex: 1, gap: 5 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  barLabel: { fontSize: 11, color: "#6B7280", width: 10, textAlign: "right" },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: "#0F1C2A",
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: { height: "100%", backgroundColor: "#F59E0B", borderRadius: 3 },

  reviewsSection: { gap: 10 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F1F5F9",
    marginBottom: 4,
  },
  reviewCard: {
    backgroundColor: "#1E2A3A",
    borderRadius: 14,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.07)",
    gap: 8,
  },
  reviewHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  reviewAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#253D56",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  reviewAvatarText: { fontSize: 11, fontWeight: "700", color: "#93C5FD" },
  reviewMeta: { flex: 1 },
  reviewerName: { fontSize: 13, fontWeight: "600", color: "#F1F5F9" },
  reviewDate: { fontSize: 11, color: "#6B7280", marginTop: 1 },
  reviewComment: { fontSize: 13, color: "#9CA3AF", lineHeight: 19 },
});
