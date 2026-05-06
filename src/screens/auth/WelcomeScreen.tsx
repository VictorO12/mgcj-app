import React from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, Image,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RootStackParamList } from '../../types'

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Welcome'>
}

export default function WelcomeScreen({ navigation }: Props) {
  return (
    <View style={styles.container}>

      <View style={styles.top}>
        <Text style={styles.wordmark}>M&G C&J</Text>
        <Text style={styles.tagline}>Your ride in the Valley</Text>

        <View style={styles.mapIllustration}>
          <View style={styles.mapBg}>
            <View style={[styles.road, styles.roadH, { top: '45%' }]} />
            <View style={[styles.road, styles.roadV, { left: '38%' }]} />
            <View style={[styles.road, styles.roadH, { top: '70%' }]} />
            <View style={styles.carDot}>
              <Text style={styles.carEmoji}>🚗</Text>
            </View>
            <View style={[styles.pinDot, { top: '20%', left: '55%' }]}>
              <Text style={styles.pinEmoji}>📍</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.bottom}>
        <Text style={styles.headline}>Get around the{'\n'}Annapolis Valley</Text>
        <Text style={styles.subheadline}>
          Book a ride in seconds. Track your driver in real time. Available in Kentville, New Minas, Wolfville and surrounding areas.
        </Text>

        <TouchableOpacity
          style={styles.signupBtn}
          onPress={() => navigation.navigate('SignUp')}
          activeOpacity={0.85}
        >
          <Text style={styles.signupBtnText}>Create an account</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.loginBtn}
          onPress={() => navigation.navigate('PhoneEntry')}
          activeOpacity={0.85}
        >
          <Text style={styles.loginBtnText}>I already have an account</Text>
        </TouchableOpacity>

        <Text style={styles.legal}>
          By continuing you agree to our Terms of Service.{'\n'}Standard message rates may apply.
        </Text>
      </View>

    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },

  top: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  wordmark: {
    fontSize: 46, fontWeight: '700', color: '#E8500A',
    letterSpacing: 1, marginBottom: 6,
  },
  tagline: { fontSize: 15, color: '#6B7280', marginBottom: 36 },

  mapIllustration: {
    width: 220, height: 180,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  mapBg: {
    flex: 1, backgroundColor: '#1d2c3f',
    position: 'relative',
  },
  road: { position: 'absolute', backgroundColor: '#253d56' },
  roadH: { left: 0, right: 0, height: 8 },
  roadV: { top: 0, bottom: 0, width: 8 },
  carDot: {
    position: 'absolute', top: '38%', left: '25%',
    backgroundColor: '#1E2A3A',
    borderRadius: 20, padding: 6,
    borderWidth: 1.5, borderColor: '#E8500A',
  },
  carEmoji: { fontSize: 18 },
  pinDot: { position: 'absolute' },
  pinEmoji: { fontSize: 22 },

  bottom: {
    backgroundColor: '#1E2A3A',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 28, paddingTop: 32,
    paddingBottom: Platform.OS === 'ios' ? 48 : 32,
  },
  headline: {
    fontSize: 28, fontWeight: '700', color: '#F1F5F9',
    lineHeight: 36, marginBottom: 12,
  },
  subheadline: {
    fontSize: 14, color: '#6B7280', lineHeight: 22, marginBottom: 32,
  },
  signupBtn: {
    backgroundColor: '#E8500A', borderRadius: 14,
    paddingVertical: 15, alignItems: 'center', marginBottom: 12,
  },
  signupBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loginBtn: {
    backgroundColor: 'transparent', borderRadius: 14,
    paddingVertical: 15, alignItems: 'center',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.15)',
    marginBottom: 24,
  },
  loginBtnText: { color: '#CBD5E1', fontSize: 16, fontWeight: '500' },
  legal: {
    fontSize: 11, color: '#374151', textAlign: 'center', lineHeight: 17,
  },
})
