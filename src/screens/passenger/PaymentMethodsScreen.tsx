import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import AddCardScreen from "./AddCardScreen";

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  cardholder_name: string | null;
  is_default: boolean;
}

const BRAND_COLORS: Record<string, string> = {
  Visa: "#1A56FF",
  Mastercard: "#EB001B",
  Amex: "#2E77BC",
  Discover: "#FF6600",
};

const BRAND_BG: Record<string, string> = {
  Visa: "rgba(26,86,255,0.12)",
  Mastercard: "rgba(235,0,27,0.12)",
  Amex: "rgba(46,119,188,0.12)",
  Discover: "rgba(255,102,0,0.12)",
};

interface Props {
  onClose: () => void;
}

export default function PaymentMethodsScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const [cards, setCards] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showAddCard, setShowAddCard] = useState(false);

  useEffect(() => {
    fetchCards();
  }, [profile]);

  async function fetchCards() {
    if (!profile) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("payment_methods")
      .select(
        "id, brand, last4, exp_month, exp_year, cardholder_name, is_default",
      )
      .eq("passenger_id", profile.id)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });
    if (!error && data) setCards(data);
    setLoading(false);
  }

  async function onRefresh() {
    setRefreshing(true);
    await fetchCards();
    setRefreshing(false);
  }

  async function setDefault(card: PaymentMethod) {
    if (card.is_default || !profile) return;
    setSettingDefault(card.id);

    // Unset all defaults first, then set this one
    await supabase
      .from("payment_methods")
      .update({ is_default: false })
      .eq("passenger_id", profile.id);

    await supabase
      .from("payment_methods")
      .update({ is_default: true })
      .eq("id", card.id);

    setSettingDefault(null);
    fetchCards();
  }

  function confirmDelete(card: PaymentMethod) {
    Alert.alert(
      "Remove card?",
      `Remove ${card.brand} ending in ${card.last4}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => deleteCard(card),
        },
      ],
    );
  }

  async function deleteCard(card: PaymentMethod) {
    if (!profile) return;
    setDeleting(card.id);
    await supabase
      .from("payment_methods")
      .delete()
      .eq("id", card.id)
      .eq("passenger_id", profile.id);

    // If we deleted the default and there are others, make the first one default
    if (card.is_default) {
      const remaining = cards.filter((c) => c.id !== card.id);
      if (remaining.length > 0) {
        await supabase
          .from("payment_methods")
          .update({ is_default: true })
          .eq("id", remaining[0].id);
      }
    }

    setDeleting(null);
    fetchCards();
  }

  function formatExpiry(month: number, year: number): string {
    return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
  }

  function isExpired(month: number, year: number): boolean {
    const now = new Date();
    const exp = new Date(year, month - 1);
    return exp < new Date(now.getFullYear(), now.getMonth());
  }

  if (showAddCard) {
    return (
      <AddCardScreen
        onClose={() => setShowAddCard(false)}
        onCardAdded={() => {
          setShowAddCard(false);
          fetchCards();
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color="#F1F5F9" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Payment methods</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setShowAddCard(true)}
        >
          <Ionicons name="add" size={22} color="#E8500A" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#E8500A" size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#E8500A"
            />
          }
          showsVerticalScrollIndicator={false}
        >
          {/* Cash — always shown */}
          <View style={styles.cashCard}>
            <View style={styles.cashIconWrap}>
              <Ionicons name="cash-outline" size={22} color="#1D9E75" />
            </View>
            <View style={styles.cardInfo}>
              <Text style={styles.cardBrand}>Cash</Text>
              <Text style={styles.cardSub}>Pay the driver directly</Text>
            </View>
            <View style={styles.cashBadge}>
              <Text style={styles.cashBadgeText}>Always available</Text>
            </View>
          </View>

          {/* Saved cards */}
          {cards.length === 0 ? (
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIcon}>
                <Ionicons name="card-outline" size={32} color="#374151" />
              </View>
              <Text style={styles.emptyTitle}>No saved cards</Text>
              <Text style={styles.emptySub}>
                Add a card to pay quickly without handling cash
              </Text>
              <TouchableOpacity
                style={styles.emptyAddBtn}
                onPress={() => setShowAddCard(true)}
              >
                <Ionicons name="add-circle-outline" size={18} color="#E8500A" />
                <Text style={styles.emptyAddBtnText}>Add your first card</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={styles.sectionLabel}>SAVED CARDS</Text>
              {cards.map((card) => {
                const expired = isExpired(card.exp_month, card.exp_year);
                const brandColor = BRAND_COLORS[card.brand] ?? "#6B7280";
                const brandBg =
                  BRAND_BG[card.brand] ?? "rgba(107,114,128,0.12)";
                const isSettingThis = settingDefault === card.id;
                const isDeletingThis = deleting === card.id;

                return (
                  <View
                    key={card.id}
                    style={[
                      styles.cardRow,
                      card.is_default && styles.cardRowDefault,
                      expired && styles.cardRowExpired,
                    ]}
                  >
                    {/* Brand icon */}
                    <View
                      style={[
                        styles.brandIconWrap,
                        { backgroundColor: brandBg },
                      ]}
                    >
                      <Text
                        style={[styles.brandInitial, { color: brandColor }]}
                      >
                        {card.brand.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>

                    {/* Info */}
                    <View style={styles.cardInfo}>
                      <View style={styles.cardTitleRow}>
                        <Text style={styles.cardBrand}>{card.brand}</Text>
                        {card.is_default && (
                          <View style={styles.defaultBadge}>
                            <Text style={styles.defaultBadgeText}>Default</Text>
                          </View>
                        )}
                        {expired && (
                          <View style={styles.expiredBadge}>
                            <Text style={styles.expiredBadgeText}>Expired</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.cardSub}>
                        •••• {card.last4} ·{" "}
                        {formatExpiry(card.exp_month, card.exp_year)}
                      </Text>
                      {card.cardholder_name && (
                        <Text style={styles.cardHolder}>
                          {card.cardholder_name}
                        </Text>
                      )}
                    </View>

                    {/* Actions */}
                    <View style={styles.cardActions}>
                      {!card.is_default && !expired && (
                        <TouchableOpacity
                          style={styles.setDefaultBtn}
                          onPress={() => setDefault(card)}
                          disabled={!!settingDefault}
                        >
                          {isSettingThis ? (
                            <ActivityIndicator size="small" color="#E8500A" />
                          ) : (
                            <Text style={styles.setDefaultText}>
                              Set default
                            </Text>
                          )}
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => confirmDelete(card)}
                        disabled={!!deleting}
                      >
                        {isDeletingThis ? (
                          <ActivityIndicator size="small" color="#F87171" />
                        ) : (
                          <Ionicons
                            name="trash-outline"
                            size={16}
                            color="#F87171"
                          />
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {/* Add another card */}
              <TouchableOpacity
                style={styles.addAnotherBtn}
                onPress={() => setShowAddCard(true)}
                activeOpacity={0.8}
              >
                <Ionicons name="add-circle-outline" size={18} color="#E8500A" />
                <Text style={styles.addAnotherText}>Add another card</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
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
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.07)",
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#F1F5F9" },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(232,80,10,0.12)",
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 10 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4B5563",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 4,
    marginLeft: 4,
  },

  // Cash card
  cashCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(29,158,117,0.08)",
    borderRadius: 16,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(29,158,117,0.2)",
  },
  cashIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "rgba(29,158,117,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  cashBadge: {
    backgroundColor: "rgba(29,158,117,0.15)",
    borderRadius: 10,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  cashBadgeText: { fontSize: 10, color: "#1D9E75", fontWeight: "600" },

  // Saved card row
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1E2A3A",
    borderRadius: 16,
    padding: 14,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.08)",
  },
  cardRowDefault: {
    borderColor: "rgba(232,80,10,0.35)",
    backgroundColor: "rgba(232,80,10,0.05)",
  },
  cardRowExpired: {
    opacity: 0.5,
  },
  brandIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  brandInitial: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  cardInfo: { flex: 1, gap: 3 },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flexWrap: "wrap",
  },
  cardBrand: { fontSize: 15, fontWeight: "600", color: "#F1F5F9" },
  cardSub: { fontSize: 12, color: "#6B7280", letterSpacing: 0.5 },
  cardHolder: { fontSize: 11, color: "#4B5563" },
  defaultBadge: {
    backgroundColor: "rgba(232,80,10,0.15)",
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.3)",
  },
  defaultBadgeText: { fontSize: 10, color: "#E8500A", fontWeight: "600" },
  expiredBadge: {
    backgroundColor: "rgba(248,113,113,0.12)",
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  expiredBadgeText: { fontSize: 10, color: "#F87171", fontWeight: "600" },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  setDefaultBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.3)",
    backgroundColor: "rgba(232,80,10,0.08)",
  },
  setDefaultText: { fontSize: 11, color: "#E8500A", fontWeight: "500" },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(248,113,113,0.08)",
    borderWidth: 0.5,
    borderColor: "rgba(248,113,113,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Empty state
  emptyWrap: {
    alignItems: "center",
    paddingVertical: 32,
    gap: 10,
  },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "#1E2A3A",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: "#F1F5F9" },
  emptySub: {
    fontSize: 13,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 20,
  },
  emptyAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 8,
    paddingVertical: 11,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: "rgba(232,80,10,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.3)",
  },
  emptyAddBtnText: { color: "#E8500A", fontSize: 14, fontWeight: "600" },

  // Add another
  addAnotherBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 0.5,
    borderColor: "rgba(232,80,10,0.25)",
    borderStyle: "dashed",
    marginTop: 4,
  },
  addAnotherText: { color: "#E8500A", fontSize: 14, fontWeight: "500" },
});
