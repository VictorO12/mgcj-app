import React from 'react'
import { View, ActivityIndicator, StyleSheet } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useAuth } from './src/hooks/useAuth'
import { RootStackParamList } from './src/types'

import WelcomeScreen from './src/screens/auth/WelcomeScreen'
import PhoneEntryScreen from './src/screens/auth/PhoneEntryScreen'
import SignUpScreen from './src/screens/auth/SignUpScreen'
import OTPVerifyScreen from './src/screens/auth/OTPVerifyScreen'
import PassengerHomeScreen from './src/screens/passenger/PassengerHomeScreen'
import DriverApp from './src/screens/driver/DriverApp'

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#E8500A" size="large" />
      </View>
    )
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
        {!session ? (
          // ── Not logged in ──
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="SignUp" component={SignUpScreen} />
            <Stack.Screen
              name="OTPVerify"
              component={OTPVerifyScreen}
              options={{ animation: 'slide_from_right' }}
            />
          </>
        ) : profile?.role === 'driver' ? (
          // ── Logged in as driver ──
          <Stack.Screen name="DriverHome" component={DriverApp} />
        ) : (
          // ── Logged in as passenger ──
          <Stack.Screen name="PassengerHome" component={PassengerHomeScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
})
