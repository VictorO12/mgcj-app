import React, { useState, useEffect, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import type { Colors } from "../../theme/colors";

interface MessageRow {
  id: string;
  category: "announcement" | "offer";
  title: string;
  body: string;
  image_url: string | null;
  expires_at: string | null;
  created_at: string;
}

const CATEGORY_ICON: Record<string, string> = {
  announcement: "megaphone-outline",
  offer: "pricetag-outline",
};

interface Props {
  onClose: () => void;
}

export default function InboxScreen({ onClose }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const targetType = profile?.role === "driver" ? "all_drivers" : "all_passengers";
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<MessageRow | null>(null);

  useEffect(() => {
    fetchInbox();
  }, [profile]);

  useEffect(() => {
    if (!profile?.company_id) return;
    const channel = supabase
      .channel("broadcast-inbox-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `company_id=eq.${profile.company_id}`,
        },
        (payload) => {
          const row = payload.new as any;
          if (row.target_type !== targetType) return;
          setMessages((prev) => [row, ...prev]);
          setUnreadIds((prev) => new Set(prev).add(row.id));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile, targetType]);

  async function fetchInbox(isRefresh = false) {
    if (!profile?.company_id) {
      setLoading(false);
      return;
    }
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const { data } = await supabase
        .from("messages")
        .select("id, category, title, body, image_url, expires_at, created_at")
        .eq("target_type", targetType)
        .eq("company_id", profile.company_id)
        .gte("created_at", profile.created_at)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .order("created_at", { ascending: false })
        .limit(100);

      const rows = data ?? [];
      setMessages(rows);

      if (rows.length > 0) {
        const { data: reads } = await supabase
          .from("message_reads")
          .select("message_id")
          .eq("profile_id", profile.id)
          .in("message_id", rows.map((r) => r.id));
        const readSet = new Set((reads ?? []).map((r) => r.message_id));
        setUnreadIds(new Set(rows.filter((r) => !readSet.has(r.id)).map((r) => r.id)));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function openMessage(m: MessageRow) {
    setSelected(m);
    if (!unreadIds.has(m.id) || !profile) return;
    setUnreadIds((prev) => {
      const next = new Set(prev);
      next.delete(m.id);
      return next;
    });
    await supabase
      .from("message_reads")
      .upsert([{ message_id: m.id, profile_id: profile.id }], {
        onConflict: "message_id,profile_id",
        ignoreDuplicates: true,
      });
  }

  if (selected) {
    const isOffer = selected.category === "offer";
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => setSelected(null)}>
            <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Message</Text>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.detailContent}
          showsVerticalScrollIndicator={false}
        >
          {selected.image_url && (
            <Image source={{ uri: selected.image_url }} style={styles.detailImage} />
          )}
          <View style={styles.detailBadgeRow}>
            <Ionicons
              name={CATEGORY_ICON[selected.category] as any}
              size={14}
              color={isOffer ? colors.accentOrange : colors.accentBlue}
            />
            <Text style={styles.detailDate}>
              {new Date(selected.created_at).toLocaleDateString("en-CA", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          </View>
          <Text style={styles.detailTitle}>{selected.title}</Text>
          <Text style={styles.detailText}>{selected.body}</Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose}>
          <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Messages</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator color={colors.accentOrange} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.centerFill}>
          <Ionicons name="mail-outline" size={40} color={colors.textFaint} />
          <Text style={styles.emptyText}>No messages yet</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchInbox(true)}
              tintColor={colors.accentOrange}
            />
          }
        >
          {messages.map((m) => {
            const isUnread = unreadIds.has(m.id);
            const isOffer = m.category === "offer";
            return (
              <TouchableOpacity
                key={m.id}
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => openMessage(m)}
              >
                <View style={styles.cardTop}>
                  <View style={styles.cardBadgeRow}>
                    <View
                      style={[
                        styles.categoryIcon,
                        { backgroundColor: isOffer ? "rgba(232,80,10,0.12)" : "rgba(96,165,250,0.12)" },
                      ]}
                    >
                      <Ionicons
                        name={CATEGORY_ICON[m.category] as any}
                        size={14}
                        color={isOffer ? colors.accentOrange : colors.accentBlue}
                      />
                    </View>
                    {isUnread && <View style={styles.unreadDot} />}
                  </View>
                  <Text style={styles.cardDate}>
                    {new Date(m.created_at).toLocaleDateString("en-CA", {
                      month: "short",
                      day: "numeric",
                    })}
                  </Text>
                </View>
                <Text style={styles.cardTitle}>{m.title}</Text>
                <Text style={styles.cardBody} numberOfLines={2}>
                  {m.body}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
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
      paddingHorizontal: 20,
      paddingBottom: 16,
      backgroundColor: colors.backgroundOverlay,
      borderBottomWidth: 0.5,
      borderBottomColor: colors.border,
    },
    backBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { fontSize: 17, fontWeight: "700", color: colors.textPrimary },
    centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
    emptyText: { fontSize: 14, color: colors.textSecondary },
    scroll: { flex: 1 },
    scrollContent: { padding: 20, paddingBottom: 48, gap: 10 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 0.5,
      borderColor: colors.border,
      padding: 16,
    },
    cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    cardBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    categoryIcon: {
      width: 26,
      height: 26,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    unreadDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.accentOrange },
    cardDate: { fontSize: 11, color: colors.textFaint },
    cardTitle: { fontSize: 14, fontWeight: "600", color: colors.textPrimary, marginBottom: 4 },
    cardBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
    detailContent: { padding: 20, paddingBottom: 48 },
    detailImage: { width: "100%", height: 200, borderRadius: 14, marginBottom: 16 },
    detailBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    detailDate: { fontSize: 12, color: colors.textFaint },
    detailTitle: { fontSize: 19, fontWeight: "700", color: colors.textPrimary, marginBottom: 12 },
    detailText: { fontSize: 15, color: colors.textSecondary, lineHeight: 22 },
  });
