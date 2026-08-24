import React, { useEffect } from "react";
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
  const { session, profile, loading, signOut } = useAuth();
  const { colors } = useTheme();

  // Auto sign-out if the driver's account was deleted while they were logged in
  useEffect(() => {
    if (session && profile?.role === 'driver' && profile.deleted_at) {
      signOut();
    }
  }, [profile?.deleted_at]);

  if (loading) {
    // The two full-screen spinners in this file (this one and the font gate in
    // <App/>) used to be pixel-identical, which made a "stuck on a spinner"
    // report impossible to attribute: fonts and session are completely
    // different failure paths. Label them under __DEV__ so the next occurrence
    // names itself instead of needing a guess.
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accentOrange} size="large" />
        {__DEV__ && <Text style={styles.gateLabel}>session</Text>}
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

  // Proceed on a font ERROR as well as on success. Discarding the second
  // element meant any font-load failure pinned `fontsLoaded` at false forever
  // and the app sat on this spinner with no way out but a relaunch — a
  // permanent hang for a purely cosmetic asset. applyFontPatch() maps weights
  // onto Manrope but the platform default is a working fallback, so an
  // unstyled app beats an app that never launches.
  const fontsReady = fontsLoaded || !!fontError;

  useEffect(() => {
    if (fontError) console.warn("[Fonts] load failed, continuing:", fontError);
  }, [fontError]);

  if (!fontsReady) {
    // Brief; the native splash covers cold start, this covers the font-load tail.
    return (
      <View style={[styles.loading, { backgroundColor: "#111827" }]}>
        <ActivityIndicator color="#E8500A" size="large" />
        {__DEV__ && <Text style={styles.gateLabel}>fonts</Text>}
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
