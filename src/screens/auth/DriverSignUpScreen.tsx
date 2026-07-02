import React, { useState, useMemo } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert, ScrollView,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RootStackParamList } from '../../types'
import { supabase } from '../../lib/supabase'
import { useTheme } from '../../theme/ThemeContext'
import type { Colors } from '../../theme/colors'

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
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
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
                placeholderTextColor={colors.textMuted}
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
                placeholderTextColor={colors.textMuted}
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
                placeholderTextColor={colors.textMuted}
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
              placeholderTextColor={colors.textMuted}
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

const makeStyles = (colors: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flexGrow: 1, paddingHorizontal: 24, paddingTop: Platform.OS === 'ios' ? 60 : 40, paddingBottom: 40 },
  backBtn: { marginBottom: 28 },
  backText: { color: colors.textSecondary, fontSize: 15 },
  title: { fontSize: 28, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: 32 },
  form: {
    backgroundColor: colors.surface, borderRadius: 20, padding: 20,
    borderWidth: 0.5, borderColor: colors.border, gap: 16,
  },
  nameRow: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '500', color: colors.textTertiary, letterSpacing: 0.04 },
  input: {
    backgroundColor: colors.background, borderRadius: 12,
    borderWidth: 0.5, borderColor: colors.borderStrong,
    paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: colors.textPrimary,
  },
  inputError: { borderColor: 'rgba(226,75,74,0.6)' },
  codeInput: {
    fontSize: 18, fontWeight: '600', letterSpacing: 0.2,
    textAlign: 'center', color: colors.accentGreen,
  },
  errorText: { fontSize: 12, color: colors.accentRed, marginTop: 2 },
  codeHint: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  phoneRow: {
    flexDirection: 'row', backgroundColor: colors.background,
    borderRadius: 12, borderWidth: 0.5, borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  countryCode: {
    paddingHorizontal: 14, paddingVertical: 13,
    borderRightWidth: 0.5, borderRightColor: colors.borderStrong,
  },
  countryCodeText: { fontSize: 15, color: colors.textOnSurfaceLight },
  phoneInput: {
    flex: 1, paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: colors.textPrimary,
  },
  btn: {
    backgroundColor: colors.accentGreen, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  loginRow: {
    flexDirection: 'row', justifyContent: 'center',
    alignItems: 'center', marginTop: 28,
  },
  loginText: { fontSize: 14, color: colors.textSecondary },
  loginLink: { fontSize: 14, color: colors.accentOrange, fontWeight: '600' },
})
