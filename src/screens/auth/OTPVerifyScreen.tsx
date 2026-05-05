import React, { useState, useRef, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RouteProp } from '@react-navigation/native'
import { RootStackParamList } from '../../types'
import { supabase } from '../../lib/supabase'

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'OTPVerify'>
  route: RouteProp<RootStackParamList, 'OTPVerify'>
}

const CODE_LENGTH = 6

export default function OTPVerifyScreen({ navigation, route }: Props) {
  const { phone } = route.params
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''))
  const [loading, setLoading] = useState(false)
  const [resendTimer, setResendTimer] = useState(30)
  const inputRefs = useRef<(TextInput | null)[]>([])

  // Countdown timer for resend button
  useEffect(() => {
    if (resendTimer <= 0) return
    const t = setTimeout(() => setResendTimer(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [resendTimer])

  function handleDigit(value: string, index: number) {
    // Handle paste of full 6-digit code
    if (value.length === CODE_LENGTH) {
      const pasted = value.replace(/\D/g, '').slice(0, CODE_LENGTH).split('')
      setDigits(pasted)
      inputRefs.current[CODE_LENGTH - 1]?.focus()
      verifyCode(pasted.join(''))
      return
    }
    const digit = value.replace(/\D/g, '').slice(-1)
    const updated = [...digits]
    updated[index] = digit
    setDigits(updated)
    if (digit && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }
    if (updated.every(d => d !== '') && digit) {
      verifyCode(updated.join(''))
    }
  }

  function handleBackspace(index: number) {
    if (digits[index]) {
      const updated = [...digits]
      updated[index] = ''
      setDigits(updated)
    } else if (index > 0) {
      inputRefs.current[index - 1]?.focus()
      const updated = [...digits]
      updated[index - 1] = ''
      setDigits(updated)
    }
  }

  async function verifyCode(code: string) {
    setLoading(true)
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token: code,
      type: 'sms',
    })
    if (error) {
      setLoading(false)
      setDigits(Array(CODE_LENGTH).fill(''))
      inputRefs.current[0]?.focus()
      Alert.alert('Incorrect code', 'That code didn\'t match. Try again.')
      return
    }

    // Create profile row if this is their first login
    if (data.user) {
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', data.user.id)
        .single()

      if (!existing) {
        await supabase.from('profiles').insert({
          id: data.user.id,
          phone,
          role: 'passenger',
        })
      }
    }
    // Navigation handled by useAuth listener in App.tsx
    setLoading(false)
  }

  async function handleResend() {
    const { error } = await supabase.auth.signInWithOtp({ phone })
    if (error) { Alert.alert('Error', error.message); return }
    setResendTimer(30)
    setDigits(Array(CODE_LENGTH).fill(''))
    inputRefs.current[0]?.focus()
    Alert.alert('Code sent', 'A new code has been sent to your phone.')
  }

  const displayPhone = phone.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, '$1 ($2) $3-$4')

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Check your texts</Text>
        <Text style={styles.subtitle}>
          We sent a 6-digit code to{'\n'}
          <Text style={styles.phoneHighlight}>{displayPhone}</Text>
        </Text>

        <View style={styles.codeRow}>
          {digits.map((digit, i) => (
            <TextInput
              key={i}
              ref={ref => { inputRefs.current[i] = ref }}
              style={[styles.digitBox, digit ? styles.digitBoxFilled : null]}
              value={digit}
              onChangeText={v => handleDigit(v, i)}
              onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === 'Backspace') handleBackspace(i)
              }}
              keyboardType="number-pad"
              maxLength={6}
              selectTextOnFocus
              autoFocus={i === 0}
            />
          ))}
        </View>

        {loading && (
          <View style={styles.verifyingRow}>
            <ActivityIndicator color="#E8500A" size="small" />
            <Text style={styles.verifyingText}>Verifying…</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.resendBtn}
          onPress={handleResend}
          disabled={resendTimer > 0}
          activeOpacity={0.7}
        >
          <Text style={[styles.resendText, resendTimer > 0 && styles.resendDisabled]}>
            {resendTimer > 0 ? `Resend code in ${resendTimer}s` : 'Resend code'}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  inner: { flex: 1, paddingHorizontal: 28, paddingTop: 64 },
  backBtn: { marginBottom: 36 },
  backText: { color: '#6B7280', fontSize: 15 },
  title: {
    fontSize: 28, fontWeight: '700', color: '#F1F5F9', marginBottom: 10,
  },
  subtitle: { fontSize: 15, color: '#6B7280', lineHeight: 22, marginBottom: 40 },
  phoneHighlight: { color: '#E8500A', fontWeight: '600' },
  codeRow: {
    flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 32,
  },
  digitBox: {
    width: 46, height: 58,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#1E2A3A',
    textAlign: 'center',
    fontSize: 24, fontWeight: '600', color: '#F1F5F9',
  },
  digitBoxFilled: { borderColor: '#E8500A' },
  verifyingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginBottom: 24,
  },
  verifyingText: { color: '#E8500A', fontSize: 14 },
  resendBtn: { alignItems: 'center', marginTop: 8 },
  resendText: { fontSize: 14, color: '#E8500A', fontWeight: '500' },
  resendDisabled: { color: '#374151' },
})
