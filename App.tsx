import React from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
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
  const { session, profile, loading } = useAuth();
  const { colors } = useTheme();

  if (loading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accentOrange} size="large" />
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
});
