import React, { useMemo } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
} from 'react-native'
import { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { RootStackParamList } from '../../types'
import { useTheme } from '../../theme/ThemeContext'
import type { Colors } from '../../theme/colors'

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DriverWelcome'>
}

export default function DriverWelcomeScreen({ navigation }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>🚗</Text>
        </View>

        <Text style={styles.title}>Driver portal</Text>
        <Text style={styles.subtitle}>
          M&G C&J drivers must be registered by dispatch staff before accessing the app.
        </Text>

        <View style={styles.cards}>
          <TouchableOpacity
            style={styles.card}
            onPress={() => navigation.navigate('DriverSignUp')}
            activeOpacity={0.85}
          >
            <View style={styles.cardIcon}>
              <Text style={styles.cardEmoji}>✨</Text>
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>Register as driver</Text>
              <Text style={styles.cardDesc}>
                New driver? You'll need an invite code from M&G C&J dispatch.
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.card}
            onPress={() => navigation.navigate('PhoneEntry')}
            activeOpacity={0.85}
          >
            <View style={styles.cardIcon}>
              <Text style={styles.cardEmoji}>👋</Text>
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>Driver log in</Text>
              <Text style={styles.cardDesc}>
                Already registered? Log in with your phone number.
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Don't have an invite code? Contact M&G C&J at (902) 000-0000 to get registered.
          </Text>
        </View>
      </View>
    </View>
  )
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: Platform.OS === 'ios' ? 56 : 40 },
  backBtn: { paddingHorizontal: 24, paddingBottom: 16 },
  backText: { color: colors.textSecondary, fontSize: 15 },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 16 },
  iconWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: 'rgba(29,158,117,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(29,158,117,0.3)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 20,
  },
  icon: { fontSize: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.textPrimary, marginBottom: 10 },
  subtitle: { fontSize: 14, color: colors.textSecondary, lineHeight: 22, marginBottom: 32 },
  cards: { gap: 12, marginBottom: 24 },
  card: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 18,
    borderWidth: 0.5, borderColor: colors.border,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  cardIcon: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(29,158,117,0.1)',
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  cardEmoji: { fontSize: 20 },
  cardText: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  cardDesc: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  notice: {
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderRadius: 12, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(245,158,11,0.2)',
  },
  noticeText: { fontSize: 13, color: colors.accentAmberText, lineHeight: 18, textAlign: 'center' },
})
