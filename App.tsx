import React, { useEffect } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StripeProvider } from "@stripe/stripe-react-native";
import Constants from "expo-constants";
import { AuthProvider, useAuth } from "./src/hooks/AuthContext";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
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
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accentOrange} size="large" />
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
  return (
    <ThemeProvider>
      <StripeProvider publishableKey={STRIPE_KEY}>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </StripeProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
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
