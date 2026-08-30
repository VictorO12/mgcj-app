import React, { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectivity } from "../lib/connectivity";
import { useAuth } from "../hooks/AuthContext";

/**
 * A thin app-wide bar saying the backend is unreachable.
 *
 * Deliberately NOT a blocking overlay. Most of the app stays useful without a
 * connection — a driver still needs the map and the details of the ride they
 * are already on, a passenger still needs their driver's plate and phone
 * number — and covering that up would take away information at the exact
 * moment it is hardest to get back. This states the condition and stays out of
 * the way.
 *
 * It also shows a brief "Back online" so recovery is visible. Without it the
 * bar just vanishes, which reads as the app giving up rather than reconnecting
 * — and the user has no way to tell whether the thing they were trying to do
 * is now worth retrying.
 */
export default function OfflineBanner() {
  const online = useConnectivity();
  // The launch gate states the same thing full-screen, with a Try again and an
  // explanation of what happens next. Stacking a bar on top of it would just be
  // the same sentence twice.
  const { loading } = useAuth();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(!online);
  const [recovered, setRecovered] = useState(false);
  const slide = useRef(new Animated.Value(online ? -1 : 0)).current;
  // Suppresses the "Back online" flash on a launch that was never offline.
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setRecovered(false);
      setVisible(true);
      Animated.timing(slide, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (!wasOffline.current) return;
    wasOffline.current = false;
    setRecovered(true);
    const hide = setTimeout(() => {
      Animated.timing(slide, {
        toValue: -1,
        duration: 220,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    }, 1800);
    return () => clearTimeout(hide);
  }, [online]);

  if (loading || !visible) return null;

  const height = 28 + insets.top;

  return (
    <Animated.View
      // `box-none` is load-bearing: the bar sits above the whole app, and
      // without it the padded area under the status bar would swallow taps
      // meant for whatever is behind it.
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          height,
          paddingTop: insets.top,
          backgroundColor: recovered ? "#1D9E75" : "#4B5563",
          transform: [
            {
              translateY: slide.interpolate({
                inputRange: [-1, 0],
                outputRange: [-height, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Text style={styles.text}>
        {recovered ? "Back online" : "No internet connection"}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    // Above every screen, including the passenger overlays that render as
    // absolutely-positioned siblings rather than through the navigator.
    zIndex: 9999,
    elevation: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
});
