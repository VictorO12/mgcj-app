import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, {
  DateTimePickerAndroid,
} from "@react-native-community/datetimepicker";
import { useTheme } from "../theme/ThemeContext";
import type { Colors } from "../theme/colors";

const CAL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function calDaysInMonth(y: number, mo: number) {
  return new Date(y, mo + 1, 0).getDate();
}
function calFirstWeekday(y: number, mo: number) {
  return new Date(y, mo, 1).getDay();
}
function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function formatTimeOfDay(d: Date): string {
  return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

interface Props {
  value: Date | null;
  onChange: (date: Date) => void;
  maxDaysOut?: number;
}

// Reusable pickup date+time calendar, used by both the booking flow
// (PassengerHomeScreen) and the scheduled-ride edit flow. Uncontrolled
// internally — mount/unmount (e.g. via conditional rendering) to reset it.
export default function ScheduleDateTimePicker({
  value,
  onChange,
  maxDaysOut = 60,
}: Props) {
  const { colors, resolvedTheme } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  const today = React.useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const maxDate = React.useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() + maxDaysOut);
    return d;
  }, [today, maxDaysOut]);

  const [calMonth, setCalMonth] = useState(() => {
    const base = value ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [selectedCalDay, setSelectedCalDay] = useState<Date | null>(value);
  const [selectedTime, setSelectedTime] = useState<Date | null>(value);
  const [iosTimePickerOpen, setIosTimePickerOpen] = useState(false);

  useEffect(() => {
    if (selectedCalDay && selectedTime) {
      const d = new Date(selectedCalDay);
      d.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
      onChange(d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCalDay, selectedTime]);

  function buildCalGrid(): (Date | null)[] {
    const y = calMonth.getFullYear(),
      mo = calMonth.getMonth();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < calFirstWeekday(y, mo); i++) cells.push(null);
    for (let d = 1; d <= calDaysInMonth(y, mo); d++)
      cells.push(new Date(y, mo, d));
    return cells;
  }
  function isDateSelectable(d: Date) {
    const dd = new Date(d);
    dd.setHours(0, 0, 0, 0);
    return dd >= today && dd <= maxDate;
  }
  function openTimePicker() {
    if (!selectedCalDay) return;
    const isToday = isSameDay(selectedCalDay, today);
    const minDate = isToday ? new Date() : undefined;
    const base =
      selectedTime && (!minDate || selectedTime >= minDate)
        ? selectedTime
        : (minDate ?? new Date());
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: base,
        mode: "time",
        is24Hour: false,
        minimumDate: minDate,
        onChange: (event, date) => {
          if (event.type === "set" && date) setSelectedTime(date);
        },
      });
    } else {
      setIosTimePickerOpen(true);
    }
  }

  return (
    <View style={styles.calendarWrap}>
      <View style={styles.calHeader}>
        <TouchableOpacity
          style={styles.calNavBtn}
          onPress={() => {
            const prev = new Date(
              calMonth.getFullYear(),
              calMonth.getMonth() - 1,
              1,
            );
            const thisMonth = new Date(
              today.getFullYear(),
              today.getMonth(),
              1,
            );
            if (prev >= thisMonth) setCalMonth(prev);
          }}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.calMonthLabel}>
          {CAL_MONTHS[calMonth.getMonth()]} {calMonth.getFullYear()}
        </Text>
        <TouchableOpacity
          style={styles.calNavBtn}
          onPress={() =>
            setCalMonth(
              new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1),
            )
          }
        >
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <View style={styles.calWeekRow}>
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
          <Text key={d} style={styles.calWeekLabel}>
            {d}
          </Text>
        ))}
      </View>
      <View style={styles.calGrid}>
        {buildCalGrid().map((day, idx) => {
          if (!day) return <View key={`e-${idx}`} style={styles.calCell} />;
          const selectable = isDateSelectable(day);
          const isSelected = selectedCalDay ? isSameDay(day, selectedCalDay) : false;
          const isToday2 = isSameDay(day, today);
          return (
            <TouchableOpacity
              key={day.toISOString()}
              style={[
                styles.calCell,
                isSelected && styles.calCellSelected,
                isToday2 && !isSelected && styles.calCellToday,
              ]}
              onPress={() => {
                if (!selectable) return;
                setSelectedCalDay(day);
                setSelectedTime(null);
                setIosTimePickerOpen(false);
              }}
              disabled={!selectable}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.calDayText,
                  !selectable && styles.calDayDisabled,
                  isSelected && styles.calDaySelected,
                  isToday2 && !isSelected && styles.calDayToday,
                ]}
              >
                {day.getDate()}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {selectedCalDay && (
        <View style={styles.timeSection}>
          <Text style={styles.timeSectionLabel}>Pickup time</Text>
          <TouchableOpacity
            style={styles.timePickerRow}
            onPress={openTimePicker}
            activeOpacity={0.8}
          >
            <View style={styles.timePickerIconWrap}>
              <Ionicons name="time-outline" size={16} color={colors.accentPurple} />
            </View>
            <Text
              style={[
                styles.timePickerText,
                !selectedTime && styles.timePickerPlaceholder,
              ]}
            >
              {selectedTime ? formatTimeOfDay(selectedTime) : "Select a time"}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          {Platform.OS === "ios" && iosTimePickerOpen && (
            <View style={styles.iosTimePickerWrap}>
              <DateTimePicker
                mode="time"
                display="spinner"
                value={selectedTime ?? new Date()}
                minimumDate={
                  isSameDay(selectedCalDay, today) ? new Date() : undefined
                }
                themeVariant={resolvedTheme === "dark" ? "dark" : "light"}
                onChange={(_, date) => date && setSelectedTime(date)}
                style={styles.iosTimePicker}
              />
              <TouchableOpacity
                style={styles.timePickerDoneBtn}
                onPress={() => setIosTimePickerOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.timePickerDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
      {selectedCalDay && selectedTime && (
        <View style={styles.schedSummary}>
          <Ionicons name="checkmark-circle" size={15} color={colors.accentPurple} />
          <Text style={styles.schedSummaryText}>
            {(() => {
              const d = new Date(selectedCalDay);
              d.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
              return d.toLocaleString("en-CA", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });
            })()}
          </Text>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    calendarWrap: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 0.5,
      borderColor: "rgba(168,85,247,0.25)",
      padding: 12,
      marginBottom: 12,
    },
    calHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    calNavBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    calMonthLabel: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
    calWeekRow: { flexDirection: "row", marginBottom: 4 },
    calWeekLabel: {
      flex: 1,
      textAlign: "center",
      fontSize: 10,
      fontWeight: "600",
      color: colors.textMuted,
      textTransform: "uppercase",
    },
    calGrid: { flexDirection: "row", flexWrap: "wrap" },
    calCell: {
      width: `${100 / 7}%` as any,
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 100,
    },
    calCellSelected: { backgroundColor: colors.accentPurple },
    calCellToday: { borderWidth: 1, borderColor: "rgba(168,85,247,0.5)" },
    calDayText: { fontSize: 13, color: colors.textTertiary, fontWeight: "500" },
    calDayDisabled: { color: colors.textFaint },
    calDaySelected: { color: "#fff", fontWeight: "700" },
    calDayToday: { color: colors.accentPurple, fontWeight: "700" },
    timeSection: {
      marginTop: 10,
      borderTopWidth: 0.5,
      borderTopColor: colors.borderSubtle,
      paddingTop: 10,
    },
    timeSectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    timePickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.background,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    timePickerIconWrap: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: "rgba(168,85,247,0.14)",
      alignItems: "center",
      justifyContent: "center",
    },
    timePickerText: {
      flex: 1,
      fontSize: 14,
      fontWeight: "600",
      color: colors.textPrimary,
    },
    timePickerPlaceholder: { color: colors.textMuted, fontWeight: "500" },
    iosTimePickerWrap: {
      marginTop: 8,
      backgroundColor: colors.background,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      overflow: "hidden",
    },
    iosTimePicker: { height: 170 },
    timePickerDoneBtn: {
      alignItems: "center",
      paddingVertical: 10,
      borderTopWidth: 0.5,
      borderTopColor: colors.borderSubtle,
    },
    timePickerDoneText: { color: colors.accentPurple, fontSize: 14, fontWeight: "700" },
    schedSummary: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 0.5,
      borderTopColor: colors.borderSubtle,
    },
    schedSummaryText: { fontSize: 13, color: colors.accentPurple, fontWeight: "600" },
  });
