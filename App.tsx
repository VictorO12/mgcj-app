import React from 'react'
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useAuth } from './src/hooks/useAuth'
import { RootStackParamList } from './src/types'

import PhoneEntryScreen from './src/screens/auth/PhoneEntryScreen'
import OTPVerifyScreen from './src/screens/auth/OTPVerifyScreen'
import PassengerHomeScreen from './src/screens/passenger/PassengerHomeScreen'

// Driver home placeholder — we build this soon
const DriverHome = () => (
  <View style={s.placeholder}>
    <Text style={s.placeholderText}>Driver Home — coming soon</Text>
  </View>
)

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return (
      <View style={s.loading}>
        <ActivityIndicator color="#E8500A" size="large" />
      </View>
    )
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
        {!session ? (
          <>
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="OTPVerify" component={OTPVerifyScreen} />
          </>
        ) : profile?.role === 'driver' ? (
          <Stack.Screen name="DriverHome" component={DriverHome} />
        ) : (
          <Stack.Screen name="PassengerHome" component={PassengerHomeScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}

const s = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  placeholder: { flex: 1, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: '#6B7280', fontSize: 16 },
})
