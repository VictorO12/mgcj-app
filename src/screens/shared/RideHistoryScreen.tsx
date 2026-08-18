import React, { useState, useEffect, useRef, useMemo } from "react";
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
import { useRideThread } from "../../hooks/useRideThread";
import RideChatScreen from "./RideChatScreen";
import RideReviewModal from "../../components/RideReviewModal";
import DriverProfileSheet from "../../components/DriverProfileSheet";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface RideRecord {
  id: string;
  status: string;
  completed_at: string | null;
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
  settlement_route: string | null;
  stripe_fee: number | null;
  platform_fee_percent_at_completion: number | null;
  refunded_amount_cents: number | null;
  transfer_reversed_cents: number | null;
}

const getStatusColors = (colors: Colors): Record<string, string> => ({
  completed: colors.accentGreen,
  cancelled: colors.accentRedDeep,
  in_progress: colors.accentOrange,
  assigned: colors.accentAmber,
  driver_arriving: colors.accentAmber,
  pending: colors.textSecondary,
});

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  cancelled: "Cancelled",
  in_progress: "In progress",
  assigned: "Assigned",
  driver_arriving: "Arriving",
  pending: "Pending",
};

// Vellon's cut is never stored directly — always derived from fare_final *
// platform_fee_percent_at_completion, the same frozen rate ops_revenue uses.
function getVellonFee(ride: RideRecord): number | null {
  const fare = ride.fare_final ?? ride.fare_estimate;
  if (fare == null || ride.platform_fee_percent_at_completion == null) return null;
  return Math.round(fare * (ride.platform_fee_percent_at_completion / 100) * 100) / 100;
}

function getNet(ride: RideRecord): number | null {
  const fare = ride.fare_final ?? ride.fare_estimate;
  const vellonFee = getVellonFee(ride);
  if (fare == null || vellonFee == null || ride.stripe_fee == null) return null;
  return Math.round((fare - vellonFee - ride.stripe_fee) * 100) / 100;
}

function settlementRouteLabel(
  route: string | null,
  companyName: string | null,
): string | null {
  switch (route) {
    case "driver_transfer":
      return "Paid directly to your account";
    case "company_transfer":
      return `Routed to ${companyName ?? "your company"} — set up payouts to receive future fares directly`;
    case "platform_invoiced":
      return "Held by Vellon for now — contact dispatch";
    case "transfer_failed":
      return "Payout issue — contact Vellon support";
    case "transfer_reversed":
      return "Payout reversed — this ride's charge was disputed";
    case "refund_reversed":
      return "Payout reversed — this ride was refunded";
    case "refund_review":
      return "This ride was refunded — payout under review";
    case "reversal_failed":
      return "Dispute issue — contact Vellon support";
    case "retransfer_failed":
      return "Dispute won, but payout didn't go through — contact Vellon support";
    default:
      return null;
  }
}

// Routes that need the driver's attention (disputed/failed), as opposed to
// the routine "here's where your money went" routes — these get a warning
// treatment instead of blending into the rest of the breakdown.
function isSettlementProblem(route: string | null): boolean {
  return (
    route === "transfer_failed" ||
    route === "transfer_reversed" ||
    route === "refund_reversed" ||
    route === "refund_review" ||
    route === "reversal_failed" ||
    route === "retransfer_failed"
  );
}

// Loaded a page at a time via .range() rather than a single big fetch — see
// fetchRides below. "Load more" appends the next page.
const PAGE_SIZE = 20;

interface Props {
  onClose: () => void;
}

export default function RideHistoryScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const STATUS_COLORS = useMemo(() => getStatusColors(colors), [colors]);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  // Which past rides actually have a thread. Without this the button would sit
  // on every row, and most rides have no messages at all.
  const [ridesWithThread, setRidesWithThread] = useState<Set<string>>(new Set());
  const [chatRide, setChatRide] = useState<RideRecord | null>(null);
  // Safe to own here rather than in a host: history only ever lists
  // completed/cancelled rides, so this can never collide with the active
  // ride's channel on the screen underneath.
  const historyThread = useRideThread(chatRide?.id);
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
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const isDriver = profile?.role === "driver";
  const fetchRidesRef = useRef<(() => Promise<void>) | undefined>(undefined);

  // Settlement breakdowns only mean anything for driver_direct drivers — a
  // company_settles driver is paid wage-style outside the app, so there's no
  // per-ride fee split to show them.
  const [payoutModel, setPayoutModel] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);

  // Lifetime settlement totals, computed server-side (driver_settlement_totals
  // RPC) over the driver's FULL ride history — NOT derived from the `rides`
  // state below, which only holds whatever pages have been loaded (starts at
  // PAGE_SIZE) and would silently under-report a driver with more rides.
  const [settlementTotals, setSettlementTotals] = useState<{
    total_fares: number;
    total_vellon_fee: number;
    total_stripe_fee: number;
    total_net: number;
    // Money reversed out of a driver's payout after the fact — a dispute
    // (full) or a driver_fault refund clawback (possibly partial). Excluded
    // from total_net (the driver doesn't have it) but reported separately so
    // the loss is visible — a total that just silently shrank would read as a
    // bug to a driver who remembers doing the ride.
    total_reversed: number;
    rides_count: number;
  } | null>(null);

  useEffect(() => {
    fetchRides(0, "initial");
  }, [profile]);

  useEffect(() => {
    if (!profile?.company_id || !isDriver) return;
    supabase
      .from("companies")
      .select("payout_model, name")
      .eq("id", profile.company_id)
      .maybeSingle()
      .then(({ data }) => {
        setPayoutModel(data?.payout_model ?? "company_settles");
        setCompanyName(data?.name ?? null);
      });
  }, [profile?.company_id, isDriver]);

  async function fetchSettlementTotals() {
    if (!isDriver || payoutModel !== "driver_direct") return;
    const { data, error } = await supabase
      .rpc("driver_settlement_totals")
      .single();
    if (!error && data) setSettlementTotals(data as typeof settlementTotals);
  }

  // company_settles drivers have no settlement RPC, but the summary strip
  // still needs a lifetime rides/earnings count that isn't capped to
  // whatever page of the paginated list happens to be loaded. Cheap: just
  // two numeric columns, no joins.
  const [companySettlesTotals, setCompanySettlesTotals] = useState<{
    rides_count: number;
    total_fares: number;
  } | null>(null);

  async function fetchCompanySettlesTotals() {
    if (!isDriver || !profile || payoutModel !== "company_settles") return;
    const { data, error } = await supabase
      .from("rides")
      .select("fare_estimate, fare_final")
      .eq("driver_id", profile.id)
      .eq("status", "completed");
    if (!error && data) {
      setCompanySettlesTotals({
        rides_count: data.length,
        total_fares: data.reduce(
          (sum, r) => sum + (r.fare_final ?? r.fare_estimate ?? 0),
          0,
        ),
      });
    }
  }

  useEffect(() => {
    fetchSettlementTotals();
    fetchCompanySettlesTotals();
  }, [isDriver, payoutModel, profile?.id]);

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

  // Single round trip: the other party's name and the ride's review rating
  // are pulled via embedded FK selects instead of a query per ride (that
  // per-ride fan-out — up to 50 sequential requests — was the main cause of
  // slow load times). Paged via .range() instead of fetching everything.
  async function fetchRides(targetPage: number, mode: "initial" | "refresh" | "more") {
    if (!profile) return;
    if (mode === "initial") setLoading(true);
    if (mode === "more") setLoadingMore(true);

    const from = targetPage * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from("rides")
      .select(
        `id, status, pickup_address, dropoff_address, fare_estimate,
         fare_final, payment_method, created_at, completed_at, driver_id, passenger_id,
         settlement_route, stripe_fee, platform_fee_percent_at_completion,
         refunded_amount_cents, transfer_reversed_cents,
         driver:drivers!rides_driver_id_fkey(profiles(name)),
         passenger:profiles!rides_passenger_id_fkey(name),
         ride_reviews(rating)`,
      )
      .in("status", ["completed", "cancelled"])
      .order("created_at", { ascending: false })
      .range(from, to);

    query = isDriver
      ? query.eq("driver_id", profile.id)
      : query.eq("passenger_id", profile.id);

    const { data, error } = await query;
    if (error || !data) {
      if (mode === "initial") setLoading(false);
      if (mode === "more") setLoadingMore(false);
      return;
    }

    const mapped: RideRecord[] = data.map((ride: any) => {
      const rating = ride.ride_reviews?.[0]?.rating ?? null;
      const hasReview = rating != null;
      const otherName = isDriver
        ? ride.passenger?.name ?? null
        : ride.driver?.profiles?.name ?? null;
      return {
        id: ride.id,
        status: ride.status,
        completed_at: ride.completed_at,
        pickup_address: ride.pickup_address,
        dropoff_address: ride.dropoff_address,
        fare_estimate: ride.fare_estimate,
        fare_final: ride.fare_final,
        payment_method: ride.payment_method,
        created_at: ride.created_at,
        other_party_name: otherName,
        other_party_id: (isDriver ? ride.passenger_id : ride.driver_id) ?? null,
        review_rating: !isDriver && hasReview ? rating : null,
        received_rating: isDriver && hasReview ? rating : null,
        driver_id: ride.driver_id ?? null,
        settlement_route: ride.settlement_route ?? null,
        stripe_fee: ride.stripe_fee ?? null,
        platform_fee_percent_at_completion:
          ride.platform_fee_percent_at_completion ?? null,
        refunded_amount_cents: ride.refunded_amount_cents ?? null,
        transfer_reversed_cents: ride.transfer_reversed_cents ?? null,
      };
    });

    setRides((prev) => (mode === "more" ? [...prev, ...mapped] : mapped));

    // One id-only query per page rather than a join: ride_messages has its own
    // RLS, and a row coming back at all is proof this user may read that
    // thread. Failure is silent on purpose -- a missing chat button is a
    // smaller problem than a history page that will not load.
    if (mapped.length) {
      const { data: threaded } = await supabase
        .from("ride_messages")
        .select("ride_id")
        .in("ride_id", mapped.map((r) => r.id));
      if (threaded) {
        const ids = new Set(threaded.map((t: any) => t.ride_id));
        setRidesWithThread((prev) =>
          mode === "more" ? new Set([...prev, ...ids]) : ids,
        );
      }
    }

    setHasMore(data.length === PAGE_SIZE);
    setPage(targetPage);
    if (mode === "initial") setLoading(false);
    if (mode === "more") setLoadingMore(false);
  }

  fetchRidesRef.current = () => fetchRides(0, "refresh");

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    await fetchRides(page + 1, "more");
  }

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([
      fetchRides(0, "refresh"),
      fetchSettlementTotals(),
      fetchCompanySettlesTotals(),
    ]);
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

  function openDriverProfile(driverId: string, rideId: string) {
    setSelectedDriverId(driverId);
    setSelectedRideId(rideId);
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

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ride history</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Driver summary strip */}
      {isDriver && (
        <View style={styles.summaryStrip}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>
              {payoutModel === "driver_direct" && settlementTotals
                ? settlementTotals.rides_count
                : (companySettlesTotals?.rides_count ??
                  rides.filter((r) => r.status === "completed").length)}
            </Text>
            <Text style={styles.summaryLabel}>Rides</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>
              $
              {(payoutModel === "driver_direct" && settlementTotals
                ? settlementTotals.total_fares
                : (companySettlesTotals?.total_fares ??
                  rides
                    .filter((r) => r.status === "completed")
                    .reduce(
                      (sum, r) => sum + (r.fare_final ?? r.fare_estimate ?? 0),
                      0,
                    ))
              ).toFixed(2)}
            </Text>
            <Text style={styles.summaryLabel}>
              {payoutModel === "driver_direct" ? "Fares" : "Earned"}
            </Text>
          </View>
          {payoutModel === "driver_direct" && settlementTotals && (
            <>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryValue, { color: colors.accentGreen }]}>
                  ${settlementTotals.total_net.toFixed(2)}
                </Text>
                <Text style={styles.summaryLabel}>Net to you</Text>
              </View>
            </>
          )}
        </View>
      )}

      {/* Reversed-funds notice. The ride itself stays counted in Rides/Fares
          above (it was really driven, the fare was really collected) — only
          the money is gone, so it's shown as an explicit deduction rather
          than by quietly shrinking the totals. Keeps the strip checkable:
          fares − vellon fee − stripe fee − reversed = net. */}
      {isDriver &&
        payoutModel === "driver_direct" &&
        settlementTotals != null &&
        settlementTotals.total_reversed > 0 && (
          <View style={styles.reversedNoticeRow}>
            <Ionicons name="warning" size={13} color={colors.accentRedDeep} />
            <Text style={styles.reversedNoticeText}>
              −${settlementTotals.total_reversed.toFixed(2)} reversed from
              disputed or refunded rides
            </Text>
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
          <ActivityIndicator color={colors.accentOrange} size="large" />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="car-outline" size={48} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>No rides yet</Text>
          <Text style={styles.emptySubtitle}>
            {isDriver
              ? "Your completed rides will appear here"
              : "Your trip history will appear here"}
          </Text>
          {hasMore && (
            <TouchableOpacity
              style={styles.loadMoreBtn}
              onPress={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <ActivityIndicator color={colors.accentOrange} size="small" />
              ) : (
                <Text style={styles.loadMoreBtnText}>
                  None on this page — load more
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accentOrange}
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
                              backgroundColor: `${STATUS_COLORS[ride.status] ?? colors.textSecondary}18`,
                              borderColor: `${STATUS_COLORS[ride.status] ?? colors.textSecondary}40`,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusText,
                              {
                                color: STATUS_COLORS[ride.status] ?? colors.textSecondary,
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
                                openDriverProfile(ride.other_party_id!, ride.id)
                              }
                              activeOpacity={0.7}
                            >
                              <Ionicons
                                name="person-outline"
                                size={11}
                                color={colors.avatarText}
                              />
                              <Text style={styles.viewProfileBtnText}>
                                View profile
                              </Text>
                            </TouchableOpacity>
                          )}
                          {ridesWithThread.has(ride.id) && (
                            <TouchableOpacity
                              style={styles.viewProfileBtn}
                              onPress={() => setChatRide(ride)}
                              activeOpacity={0.7}
                            >
                              <Ionicons
                                name="chatbubbles-outline"
                                size={11}
                                color={colors.avatarText}
                              />
                              <Text style={styles.viewProfileBtnText}>
                                Messages
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
                              { backgroundColor: colors.accentBlue },
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
                              { backgroundColor: colors.accentOrange, borderRadius: 3 },
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

                      {/* Driver: settlement breakdown (driver_direct only —
                          company_settles drivers are paid wage-style outside
                          the app, there's no per-ride fee split to show) */}
                      {isDriver &&
                        payoutModel === "driver_direct" &&
                        ride.status === "completed" && (
                          <View style={styles.settlementBox}>
                            <View style={styles.settlementRow}>
                              <Text style={styles.settlementLabel}>Fare</Text>
                              <Text style={styles.settlementValue}>
                                ${(ride.fare_final ?? 0).toFixed(2)}
                              </Text>
                            </View>
                            <View style={styles.settlementRow}>
                              <Text style={styles.settlementLabel}>
                                Vellon fee
                                {ride.platform_fee_percent_at_completion != null
                                  ? ` (${ride.platform_fee_percent_at_completion}%)`
                                  : ""}
                              </Text>
                              <Text style={styles.settlementValueNeg}>
                                -${getVellonFee(ride)?.toFixed(2) ?? "—"}
                              </Text>
                            </View>
                            {ride.payment_method === "cash" ? (
                              <View
                                style={[
                                  styles.settlementRow,
                                  styles.settlementNetRow,
                                ]}
                              >
                                <Text style={styles.settlementNetLabel}>
                                  Net to you
                                </Text>
                                <Text style={styles.settlementNetValue}>
                                  $
                                  {getVellonFee(ride) != null
                                    ? ((ride.fare_final ?? 0) - getVellonFee(ride)!).toFixed(2)
                                    : "—"}
                                </Text>
                              </View>
                            ) : ride.stripe_fee != null ? (
                              <>
                                <View style={styles.settlementRow}>
                                  <Text style={styles.settlementLabel}>
                                    Card processing fee
                                  </Text>
                                  <Text style={styles.settlementValueNeg}>
                                    -${ride.stripe_fee.toFixed(2)}
                                  </Text>
                                </View>
                                <View
                                  style={[
                                    styles.settlementRow,
                                    styles.settlementNetRow,
                                  ]}
                                >
                                  <Text style={styles.settlementNetLabel}>
                                    Net to you
                                  </Text>
                                  <Text style={styles.settlementNetValue}>
                                    ${getNet(ride)?.toFixed(2) ?? "—"}
                                  </Text>
                                </View>
                              </>
                            ) : (
                              <Text style={styles.settlementPending}>
                                Payout still processing…
                              </Text>
                            )}
                            {ride.refunded_amount_cents != null &&
                              ride.refunded_amount_cents > 0 && (
                                <>
                                  <View style={styles.settlementRow}>
                                    <Text style={styles.settlementLabel}>
                                      Refunded to rider
                                    </Text>
                                    <Text style={styles.settlementValueNeg}>
                                      -$
                                      {(
                                        ride.refunded_amount_cents / 100
                                      ).toFixed(2)}
                                    </Text>
                                  </View>
                                  {ride.transfer_reversed_cents != null &&
                                    ride.transfer_reversed_cents > 0 && (
                                      <View style={styles.settlementRow}>
                                        <Text style={styles.settlementLabel}>
                                          Reversed from your payout
                                        </Text>
                                        <Text style={styles.settlementValueNeg}>
                                          -$
                                          {(
                                            ride.transfer_reversed_cents / 100
                                          ).toFixed(2)}
                                        </Text>
                                      </View>
                                    )}
                                </>
                              )}
                            {ride.payment_method === "cash" ? (
                              <Text style={styles.settlementRouteNote}>
                                Billed to {companyName ?? "your company"}{" "}
                                monthly — not deducted from this ride.
                              </Text>
                            ) : (
                              settlementRouteLabel(
                                ride.settlement_route,
                                companyName,
                              ) &&
                              (isSettlementProblem(ride.settlement_route) ? (
                                <View style={styles.settlementWarningRow}>
                                  <Ionicons
                                    name="warning"
                                    size={13}
                                    color={colors.accentRedDeep}
                                  />
                                  <Text style={styles.settlementWarningText}>
                                    {settlementRouteLabel(
                                      ride.settlement_route,
                                      companyName,
                                    )}
                                  </Text>
                                </View>
                              ) : (
                                <Text style={styles.settlementRouteNote}>
                                  {settlementRouteLabel(
                                    ride.settlement_route,
                                    companyName,
                                  )}
                                </Text>
                              ))
                            )}
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
                                        ? colors.accentAmber
                                        : colors.textFaint
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
                                color={colors.accentAmber}
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
                                        ? colors.accentAmber
                                        : colors.textFaint
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

          {hasMore && (
            <TouchableOpacity
              style={styles.loadMoreBtn}
              onPress={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <ActivityIndicator color={colors.accentOrange} size="small" />
              ) : (
                <Text style={styles.loadMoreBtnText}>Load more rides</Text>
              )}
            </TouchableOpacity>
          )}

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
        rideId={selectedRideId}
        onClose={() => {
          setProfileSheetVisible(false);
          setSelectedDriverId(null);
          setSelectedRideId(null);
        }}
      />

      {chatRide && (
        <View style={StyleSheet.absoluteFill}>
          <RideChatScreen
            thread={historyThread}
            rideStatus={chatRide.status}
            completedAt={chatRide.completed_at}
            counterpartName={chatRide.other_party_name}
            onClose={() => setChatRide(null)}
          />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: Platform.OS === "ios" ? 56 : 40,
      paddingBottom: 16,
      paddingHorizontal: 16,
      backgroundColor: colors.background,
      borderBottomWidth: 0.5,
      borderColor: colors.borderSubtle,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
    summaryStrip: {
      flexDirection: "row",
      backgroundColor: colors.background,
      paddingVertical: 16,
      paddingHorizontal: 24,
      borderBottomWidth: 0.5,
      borderColor: colors.borderSubtle,
    },
    summaryItem: { flex: 1, alignItems: "center" },
    summaryDivider: { width: 0.5, backgroundColor: colors.border },
    summaryValue: { fontSize: 22, fontWeight: "700", color: colors.textPrimary },
    summaryLabel: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
    // Sits directly under the summary strip, so it carries the strip's own
    // horizontal padding and the same red as the per-ride problem rows.
    reversedNoticeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 24,
      paddingVertical: 8,
      backgroundColor: "rgba(226,75,74,0.12)",
      borderBottomWidth: 0.5,
      borderColor: colors.borderSubtle,
    },
    reversedNoticeText: {
      flex: 1,
      fontSize: 12,
      fontWeight: "600",
      color: colors.accentRedDeep,
    },
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
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.borderSubtle,
    },
    filterTabActive: {
      backgroundColor: colors.accentOrange,
      borderColor: colors.accentOrange,
    },
    filterTabText: { fontSize: 13, fontWeight: "500", color: colors.textSecondary },
    filterTabTextActive: { color: "#fff" },
    loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
    emptyWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingHorizontal: 40,
    },
    emptyTitle: { fontSize: 17, fontWeight: "600", color: colors.textPrimary },
    emptySubtitle: { fontSize: 13, color: colors.textSecondary, textAlign: "center" },
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
      backgroundColor: colors.borderStrong,
    },
    daySeparatorLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textSecondary,
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    rideCard: {
      backgroundColor: colors.background,
      borderRadius: 16,
      padding: 16,
      borderWidth: 0.5,
      borderColor: colors.border,
    },
    rideCardTop: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10,
    },
    rideTime: { fontSize: 13, fontWeight: "500", color: colors.textTertiary },
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
    otherParty: { fontSize: 12, color: colors.textSecondary },
    otherPartyName: { color: colors.textTertiary, fontWeight: "500" },
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
    viewProfileBtnText: { fontSize: 11, fontWeight: "600", color: colors.avatarText },
    routeWrap: { marginBottom: 12 },
    routeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    routeDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    routeText: { fontSize: 13, color: colors.textTertiary, flex: 1 },
    routeLine: {
      width: 1,
      height: 10,
      backgroundColor: colors.borderStrong,
      marginLeft: 3.5,
      marginVertical: 2,
    },
    fareRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 10,
      borderTopWidth: 0.5,
      borderColor: colors.borderSubtle,
      marginBottom: 10,
    },
    fareLabel: { fontSize: 12, color: colors.textSecondary },
    fareAmount: { fontSize: 15, fontWeight: "700", color: colors.textPrimary },
    settlementBox: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 10,
      padding: 12,
      marginBottom: 10,
      gap: 6,
    },
    settlementRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    settlementLabel: { fontSize: 12, color: colors.textTertiary },
    settlementValue: { fontSize: 13, fontWeight: "600", color: colors.textPrimary },
    settlementValueNeg: { fontSize: 13, fontWeight: "600", color: colors.accentRedDeep },
    settlementNetRow: {
      borderTopWidth: 0.5,
      borderColor: colors.borderStrong,
      paddingTop: 6,
      marginTop: 2,
    },
    settlementNetLabel: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },
    settlementNetValue: { fontSize: 15, fontWeight: "700", color: colors.accentGreen },
    settlementPending: { fontSize: 12, color: colors.textTertiary, fontStyle: "italic" },
    settlementNote: { fontSize: 12, color: colors.textOnSurfaceLight, lineHeight: 17 },
    settlementRouteNote: {
      fontSize: 11,
      color: colors.textTertiary,
      marginTop: 2,
    },
    settlementWarningRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginTop: 4,
      paddingTop: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: "rgba(226,75,74,0.12)",
    },
    settlementWarningText: {
      flex: 1,
      fontSize: 12,
      fontWeight: "600",
      color: colors.accentRedDeep,
    },
    reviewSection: {
      borderTopWidth: 0.5,
      borderColor: colors.borderSubtle,
      paddingTop: 10,
    },
    reviewedRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    starsReadOnly: { flexDirection: "row", gap: 2 },
    reviewedLabel: { fontSize: 12, color: colors.textSecondary },
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
    rateBtnText: { fontSize: 13, fontWeight: "600", color: colors.accentAmber },
    noRatingText: { fontSize: 12, color: colors.textTertiary, fontStyle: "italic" },
    loadMoreBtn: {
      alignSelf: "center",
      marginTop: 16,
      paddingVertical: 10,
      paddingHorizontal: 20,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 0.5,
      borderColor: colors.borderSubtle,
      minWidth: 140,
      alignItems: "center",
    },
    loadMoreBtnText: { fontSize: 13, fontWeight: "600", color: colors.accentOrange },
  });
