import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert, ScrollView,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RootStackParamList } from '../../types'
import { supabase } from '../../lib/supabase'

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DriverSignUp'>
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

function formatDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10)
  if (digits.length <= 3) return digits
  if (digits.length <= 6) return `(${digits.slice(0,3)}) ${digits.slice(3)}`
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
}

export default function DriverSignUpScreen({ navigation }: Props) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [codeError, setCodeError] = useState('')

  async function handleRegister() {
    if (!firstName.trim()) {
      Alert.alert('Missing name', 'Please enter your first name.')
      return
    }
    const e164 = toE164(phone)
    if (e164.replace(/\D/g, '').length < 11) {
      Alert.alert('Invalid number', 'Please enter a valid 10-digit phone number.')
      return
    }
    if (!inviteCode.trim()) {
      setCodeError('Please enter your invite code.')
      return
    }

    setLoading(true)
    setCodeError('')

    // Validate invite code BEFORE sending OTP
    const { data: invite, error: inviteError } = await supabase
      .from('driver_invites')
      .select('id, used, phone, name')
      .eq('code', inviteCode.trim().toUpperCase())
      .single()

    if (inviteError || !invite) {
      setCodeError('Invalid invite code. Please check with M&G C&J dispatch.')
      setLoading(false)
      return
    }

    if (invite.used) {
      setCodeError('This invite code has already been used.')
      setLoading(false)
      return
    }

    // Code is valid — send OTP
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: e164 })
    setLoading(false)

    if (otpError) {
      Alert.alert('Error', otpError.message)
      return
    }

    // Navigate to OTP with driver flag and invite code
    navigation.navigate('OTPVerify', {
      phone: e164,
      name: `${firstName.trim()} ${lastName.trim()}`.trim(),
      isNewUser: true,
      isDriver: true,
      inviteCode: inviteCode.trim().toUpperCase(),
    })
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">

        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Driver registration</Text>
        <Text style={styles.subtitle}>
          You'll need an invite code from M&G C&J dispatch to register as a driver.
        </Text>

        <View style={styles.form}>

          <View style={styles.nameRow}>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>First name</Text>
              <TextInput
                style={styles.input}
                placeholder="First"
                placeholderTextColor="#4B5563"
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                autoFocus
              />
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>Last name</Text>
              <TextInput
                style={styles.input}
                placeholder="Last"
                placeholderTextColor="#4B5563"
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
              />
            </View>
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.label}>Phone number</Text>
            <View style={styles.phoneRow}>
              <View style={styles.countryCode}>
                <Text style={styles.countryCodeText}>🇨🇦 +1</Text>
              </View>
              <TextInput
                style={styles.phoneInput}
                placeholder="(902) 555-1234"
                placeholderTextColor="#4B5563"
                keyboardType="phone-pad"
                value={formatDisplay(phone)}
                onChangeText={t => setPhone(t.replace(/\D/g, ''))}
                maxLength={14}
              />
            </View>
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.label}>Invite code</Text>
            <TextInput
              style={[styles.input, styles.codeInput, codeError ? styles.inputError : null]}
              placeholder="e.g. AB1C2D"
              placeholderTextColor="#4B5563"
              value={inviteCode}
              onChangeText={t => { setInviteCode(t.toUpperCase()); setCodeError('') }}
              autoCapitalize="characters"
              maxLength={8}
            />
            {codeError ? <Text style={styles.errorText}>{codeError}</Text> : null}
            <Text style={styles.codeHint}>
              Get this from M&G C&J dispatch staff when you're onboarded.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.6 }]}
            onPress={handleRegister}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>Verify & continue</Text>
            }
          </TouchableOpacity>

        </View>

        <View style={styles.loginRow}>
          <Text style={styles.loginText}>Already registered? </Text>
          <TouchableOpacity onPress={() => navigation.navigate('PhoneEntry')}>
            <Text style={styles.loginLink}>Log in</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  inner: { flexGrow: 1, paddingHorizontal: 24, paddingTop: Platform.OS === 'ios' ? 60 : 40, paddingBottom: 40 },
  backBtn: { marginBottom: 28 },
  backText: { color: '#6B7280', fontSize: 15 },
  title: { fontSize: 28, fontWeight: '700', color: '#F1F5F9', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#6B7280', lineHeight: 20, marginBottom: 32 },
  form: {
    backgroundColor: '#1E2A3A', borderRadius: 20, padding: 20,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)', gap: 16,
  },
  nameRow: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '500', color: '#9CA3AF', letterSpacing: 0.04 },
  input: {
    backgroundColor: '#111827', borderRadius: 12,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: '#F1F5F9',
  },
  inputError: { borderColor: 'rgba(226,75,74,0.6)' },
  codeInput: {
    fontSize: 18, fontWeight: '600', letterSpacing: 0.2,
    textAlign: 'center', color: '#1D9E75',
  },
  errorText: { fontSize: 12, color: '#F87171', marginTop: 2 },
  codeHint: { fontSize: 11, color: '#4B5563', marginTop: 2 },
  phoneRow: {
    flexDirection: 'row', backgroundColor: '#111827',
    borderRadius: 12, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  countryCode: {
    paddingHorizontal: 14, paddingVertical: 13,
    borderRightWidth: 0.5, borderRightColor: 'rgba(255,255,255,0.1)',
  },
  countryCodeText: { fontSize: 15, color: '#CBD5E1' },
  phoneInput: {
    flex: 1, paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: '#F1F5F9',
  },
  btn: {
    backgroundColor: '#1D9E75', borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loginRow: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', marginTop: 28,
  },
  loginText: { fontSize: 14, color: '#6B7280' },
  loginLink: { fontSize: 14, color: '#E8500A', fontWeight: '600' },
})
