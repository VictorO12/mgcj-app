import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
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


function RootNavigator() {
  const { session, profile, loading, stalled, offline, retryInit, retryConnection, signOut } =
    useAuth();
  const { colors } = useTheme();

  // Auto sign-out if the driver's account was deleted while they were logged in
  useEffect(() => {
    if (session && profile?.role === 'driver' && profile.deleted_at) {
      signOut();
    }
  }, [profile?.deleted_at]);

  if (loading) {
    // This gate waits on the session + profile; the one in <App/> waits on
    // fonts. They render identically, which is fine now but was once a real
    // cost: while the launch hang was open, a "stuck on a spinner" report could
    // not be attributed to either. If that ever recurs, distinguish them
    // temporarily rather than guessing — and do NOT gate the distinguishing
    // output on __DEV__, which is false on exactly the preview builds where the
    // problem shows up.
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accentOrange} size="large" />
        {/*
          Offline takes precedence over `stalled`. They are different problems:
          `stalled` means "slow, cause unknown", offline means "this request
          could not leave the phone", and only the second one can be stated
          plainly to a user. Showing both would be redundant and the vaguer
          message would undercut the specific one.

          It does NOT offer a way past the gate, and that is deliberate. There
          is no signed-in app to show without a profile, and dropping someone to
          Welcome would invite them to re-login — which needs an SMS OTP, i.e.
          the network they do not have.
        */}
        {offline ? (
          <>
            <Text style={[styles.stallText, { color: colors.textSecondary ?? "#9CA3AF" }]}>
              No internet connection
            </Text>
            <Text style={[styles.offlineHint, { color: colors.textSecondary ?? "#6B7280" }]}>
              We'll keep trying — you'll be signed in automatically once you're
              back online.
            </Text>
            <TouchableOpacity onPress={retryConnection} style={styles.retryBtn}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : (
          stalled && (
          <>
            <Text style={[styles.stallText, { color: colors.textSecondary ?? "#9CA3AF" }]}>
              This is taking longer than usual.
            </Text>
            <TouchableOpacity onPress={retryInit} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
            </>
          )
        )}
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

export default function App() {
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
  stallText: {
    marginTop: 24,
    fontSize: 14,
    textAlign: "center",
  },
  offlineHint: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 32,
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
