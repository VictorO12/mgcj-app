import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RootStackParamList } from '../../types'
import { supabase } from '../../lib/supabase'

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PhoneEntry'>
}

export default function PhoneEntryScreen({ navigation }: Props) {
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)

  // Format to E.164 — Supabase requires +1XXXXXXXXXX for Canadian numbers
  function toE164(raw: string): string {
    const digits = raw.replace(/\D/g, '')
    if (digits.startsWith('1') && digits.length === 11) return `+${digits}`
    if (digits.length === 10) return `+1${digits}`
    return `+${digits}`
  }

  // Pretty-format as user types: (902) 555-1234
  function formatDisplay(raw: string): string {
    const digits = raw.replace(/\D/g, '').slice(0, 10)
    if (digits.length <= 3) return digits
    if (digits.length <= 6) return `(${digits.slice(0,3)}) ${digits.slice(3)}`
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  }

  async function handleSendOTP() {
    const e164 = toE164(phone)
    if (e164.replace(/\D/g,'').length < 11) {
      Alert.alert('Invalid number', 'Please enter a valid 10-digit phone number.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({ phone: e164 })
    setLoading(false)
    if (error) {
      Alert.alert('Error', error.message)
      return
    }
    navigation.navigate('OTPVerify', { phone: e164 })
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>M&G C&J</Text>
          <Text style={styles.tagline}>Your ride in the Valley</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Enter your phone number</Text>
          <Text style={styles.sublabel}>
            We'll send a 6-digit code to verify it's you.
          </Text>

          <View style={styles.inputRow}>
            <View style={styles.countryCode}>
              <Text style={styles.countryCodeText}>🇨🇦 +1</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="(902) 555-1234"
              placeholderTextColor="#888"
              keyboardType="phone-pad"
              value={formatDisplay(phone)}
              onChangeText={(t) => setPhone(t.replace(/\D/g, ''))}
              maxLength={14}
              autoFocus
            />
          </View>

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleSendOTP}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>Send code</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          By continuing you agree to our Terms of Service.{'\n'}
          Standard message rates may apply.
        </Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  inner: { flex: 1, paddingHorizontal: 28, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 52 },
  wordmark: {
    fontSize: 42, fontWeight: '700', color: '#E8500A', letterSpacing: 1,
  },
  tagline: { fontSize: 15, color: '#6B7280', marginTop: 6 },
  form: {
    backgroundColor: '#1E2A3A',
    borderRadius: 20,
    padding: 24,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  label: { fontSize: 17, fontWeight: '600', color: '#F1F5F9', marginBottom: 6 },
  sublabel: { fontSize: 13, color: '#6B7280', marginBottom: 20, lineHeight: 18 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.12)',
    marginBottom: 20,
    overflow: 'hidden',
  },
  countryCode: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRightWidth: 0.5,
    borderRightColor: 'rgba(255,255,255,0.1)',
  },
  countryCodeText: { fontSize: 15, color: '#CBD5E1' },
  input: {
    flex: 1, paddingHorizontal: 14, paddingVertical: 14,
    fontSize: 18, color: '#F1F5F9', letterSpacing: 0.5,
  },
  btn: {
    backgroundColor: '#E8500A',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  footer: {
    marginTop: 36, textAlign: 'center',
    fontSize: 12, color: '#374151', lineHeight: 18,
  },
})
