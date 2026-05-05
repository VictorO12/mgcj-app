import React from 'react'
import { View, ActivityIndicator } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useAuth } from './src/hooks/useAuth'
import { RootStackParamList } from './src/types'

// Auth screens
import PhoneEntryScreen from './src/screens/auth/PhoneEntryScreen'
import OTPVerifyScreen from './src/screens/auth/OTPVerifyScreen'

// Placeholder screens — we'll build these next
import { View as RNView, Text, StyleSheet } from 'react-native'
const PassengerHome = () => (
  <RNView style={ph.c}><Text style={ph.t}>Passenger Home — coming next</Text></RNView>
)
const DriverHome = () => (
  <RNView style={ph.c}><Text style={ph.t}>Driver Home — coming next</Text></RNView>
)
const ph = StyleSheet.create({
  c: { flex: 1, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  t: { color: '#6B7280', fontSize: 16 },
})

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#E8500A" size="large" />
      </View>
    )
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!session ? (
          // Not logged in — show auth flow
          <>
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="OTPVerify" component={OTPVerifyScreen} />
          </>
        ) : profile?.role === 'driver' ? (
          // Logged in as driver
          <Stack.Screen name="DriverHome" component={DriverHome} />
        ) : (
          // Logged in as passenger (default)
          <Stack.Screen name="PassengerHome" component={PassengerHome} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}
