import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StripeProvider } from "@stripe/stripe-react-native";
import Constants from "expo-constants";
import { useFonts } from "expo-font";
import { AuthProvider, useAuth } from "./src/hooks/AuthContext";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { FONTS, applyFontPatch } from "./src/theme/typography";
import * as bootTrace from "./src/lib/bootTrace";

// Patch RN's Text/TextInput before any screen renders so all existing
// fontWeight styles resolve to Manrope. Fonts finish loading in <App/>.
applyFontPatch();
import { RootStackParamList } from "./src/types";
import WelcomeScreen from "./src/screens/auth/WelcomeScreen";
import PhoneEntryScreen from "./src/screens/auth/PhoneEntryScreen";
import SignUpScreen from "./src/screens/auth/SignUpScreen";
import DriverWelcomeScreen from "./src/screens/auth/DriverWelcomeScreen";
import DriverSignUpScreen from "./src/screens/auth/DriverSignUpScreen";
import OTPVerifyScreen from "./src/screens/auth/OTPVerifyScreen";
import PassengerHomeScreen from "./src/screens/passenger/PassengerHomeScreen";
import DriverApp from "./src/screens/driver/DriverApp";

const Stack = createNativeStackNavigator<RootStackParamList>();
const STRIPE_KEY = Constants.expoConfig?.extra?.stripePublishableKey ?? "";


/**
 * Live launch trace, rendered under the loading gate. TEMPORARY — remove with
 * src/lib/bootTrace.ts.
 *
 * On screen rather than in the console on purpose: the hang only reproduces on
 * PREVIEW builds, where `__DEV__` is false and there is no attached console.
 * The last round's diagnostics were __DEV__-gated and therefore emitted nothing
 * on the only build that reproduces — the whole point of this one is to be
 * readable on the device that has the bug, with no tooling.
 */
function BootTrace({ stalled }: { stalled: boolean }) {
  const [, force] = useState(0);
  const [prev, setPrev] = useState<{ total: number; lines: string[] } | null>(null);

  useEffect(() => bootTrace.subscribe(() => force((n) => n + 1)), []);

  // Ticks the elapsed counter so an OPEN span visibly counts up. Without this
  // the screen freezes on the last completed mark, which is precisely the
  // information-free state being debugged: you could not tell a wedged await
  // from a finished one.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    bootTrace.loadPreviousTrace().then(setPrev);
  }, []);

  const lines = bootTrace.formatTrace();

  return (
    <View style={styles.trace}>
      <Text style={styles.traceHead}>
        launch +{(bootTrace.sinceBoot() / 1000).toFixed(1)}s
        {prev ? `   (previous: ${(prev.total / 1000).toFixed(1)}s)` : ""}
      </Text>
      <ScrollView style={styles.traceScroll}>
        {lines.map((l, i) => (
          <Text key={i} style={styles.traceLine}>
            {l}
          </Text>
        ))}
        {stalled && prev && (
          <>
            <Text style={[styles.traceHead, { marginTop: 10 }]}>previous launch</Text>
            {prev.lines.map((l, i) => (
              <Text key={`p${i}`} style={styles.traceLine}>
                {l}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function RootNavigator() {
  const { session, profile, loading, stalled, retryInit, signOut } = useAuth();
  const { colors } = useTheme();

  // Auto sign-out if the driver's account was deleted while they were logged in
  useEffect(() => {
    if (session && profile?.role === 'driver' && profile.deleted_at) {
      signOut();
    }
  }, [profile?.deleted_at]);

  // Persists on EVERY gate release, not just the profile path, so a signed-out
  // launch is captured too — that is the control: no stored session means no
  // proactive refresh, so if it is ALSO slow the cause is not the refresh.
  useEffect(() => {
    if (!loading) bootTrace.persistTrace();
  }, [loading]);

  if (loading) {
    // The two full-screen spinners in this file (this one and the font gate in
    // <App/>) used to be pixel-identical, which made a "stuck on a spinner"
    // report impossible to attribute: fonts and session are completely
    // different failure paths.
    //
    // The label is NOT __DEV__-gated, and that is the point: it was, and the
    // hang is reported on PREVIEW builds where __DEV__ is false, so the
    // instrumentation added to diagnose it emitted nothing on the only build
    // that reproduces. Diagnostics have to be present in the build under test.
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accentOrange} size="large" />
        <Text style={styles.gateLabel}>session</Text>
        {stalled && (
          <>
            <Text style={[styles.stallText, { color: colors.textSecondary ?? "#9CA3AF" }]}>
              This is taking longer than usual.
            </Text>
            <TouchableOpacity onPress={retryInit} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </>
        )}
        <BootTrace stalled={stalled} />
      </View>
    );
  }

  // Suspended driver — block access and show a message
  if (session && profile?.role === 'driver' && profile.is_active === false) {
    return (
      <View style={styles.suspended}>
        <Text style={styles.suspendedIcon}>🚫</Text>
        <Text style={styles.suspendedTitle}>Account deactivated</Text>
        <Text style={styles.suspendedBody}>
          Your account has been deactivated. Please contact dispatch to restore access.
        </Text>
        <TouchableOpacity style={styles.suspendedBtn} onPress={signOut}>
          <Text style={styles.suspendedBtnText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: "fade" }}
      >
        {!session ? (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="SignUp" component={SignUpScreen} />
            <Stack.Screen
              name="DriverWelcome"
              component={DriverWelcomeScreen}
            />
            <Stack.Screen name="DriverSignUp" component={DriverSignUpScreen} />
            <Stack.Screen
              name="OTPVerify"
              component={OTPVerifyScreen}
              options={{ animation: "slide_from_right" }}
            />
          </>
        ) : profile?.role === "driver" ? (
          <Stack.Screen name="DriverHome" component={DriverApp} />
        ) : (
          <Stack.Screen name="PassengerHome" component={PassengerHomeScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Once-guard, and it is load-bearing rather than tidiness: `mark()` notifies
// subscribers, <BootTrace/> is a subscriber, and its re-render re-renders this
// component — so an unguarded mark in a render body is an infinite loop that
// would present as the app hanging on launch. Which is the bug being diagnosed.
let markedMount = false;

export default function App() {
  // First React render. Compared against "supabase.ts loaded" and the first
  // network span, this attributes any leading dead time to bundle startup
  // rather than to auth.
  if (!markedMount) {
    markedMount = true;
    bootTrace.mark("react mounted");
  }

  const [fontsLoaded, fontError] = useFonts(FONTS);
  // Error is not the only way a gate gets stuck — an await that never settles
  // is, and that is exactly what was hanging the session gate one level down.
  // `useFonts` exposes no timeout, so cap it here: fonts are local assets, so
  // 8s without an answer means it is not coming, and an unstyled app that
  // launches beats a styled one that does not.
  const [fontTimedOut, setFontTimedOut] = useState(false);
  useEffect(() => {
    if (fontsLoaded || fontError) return;
    const t = setTimeout(() => setFontTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, [fontsLoaded, fontError]);

  // Proceed on a font ERROR as well as on success. Discarding the second
  // element meant any font-load failure pinned `fontsLoaded` at false forever
  // and the app sat on this spinner with no way out but a relaunch — a
  // permanent hang for a purely cosmetic asset. applyFontPatch() maps weights
  // onto Manrope but the platform default is a working fallback, so an
  // unstyled app beats an app that never launches.
  const fontsReady = fontsLoaded || !!fontError || fontTimedOut;

  useEffect(() => {
    if (fontError) console.warn("[Fonts] load failed, continuing:", fontError);
  }, [fontError]);

  if (!fontsReady) {
    // Brief; the native splash covers cold start, this covers the font-load tail.
    return (
      <View style={[styles.loading, { backgroundColor: "#111827" }]}>
        <ActivityIndicator color="#E8500A" size="large" />
        <Text style={styles.gateLabel}>fonts</Text>
        {/*
          The trace belongs on THIS gate as much as the session one. RootNavigator
          — and therefore the other <BootTrace/> — does not mount until fonts are
          ready, so a hang here would have shown a bare spinner and produced no
          data at all, burning the build cycle this exists to avoid.
        */}
        <BootTrace stalled={false} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <StripeProvider publishableKey={STRIPE_KEY}>
            <AuthProvider>
              <RootNavigator />
            </AuthProvider>
          </StripeProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  gateLabel: {
    marginTop: 12,
    color: "#6B7280",
    fontSize: 12,
    letterSpacing: 1,
  },
  trace: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 24,
    maxHeight: "45%",
  },
  traceHead: {
    color: "#9CA3AF",
    fontSize: 11,
    marginBottom: 4,
  },
  traceScroll: {
    maxHeight: 220,
  },
  traceLine: {
    color: "#6B7280",
    fontSize: 10,
    lineHeight: 14,
  },
  stallText: {
    marginTop: 24,
    fontSize: 14,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 14,
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#E8500A",
  },
  retryText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  suspended: {
    flex: 1,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  suspendedIcon: {
    fontSize: 48,
    marginBottom: 20,
  },
  suspendedTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F1F5F9',
    marginBottom: 12,
    textAlign: 'center',
  },
  suspendedBody: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 36,
  },
  suspendedBtn: {
    backgroundColor: '#1E2A3A',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  suspendedBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#9CA3AF',
  },
});
