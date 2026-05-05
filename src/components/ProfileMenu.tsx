import React, { useRef, useEffect } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Dimensions, Platform, TouchableWithoutFeedback, Modal,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Profile } from '../types'

interface MenuItem {
  icon: string
  label: string
  sublabel?: string
  onPress: () => void
}

interface Props {
  profile: Profile | null
  visible: boolean
  onClose: () => void
  onSignOut: () => void
}

export default function ProfileMenu({ profile, visible, onClose, onSignOut }: Props) {
  const slideY = useRef(new Animated.Value(600)).current
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideY, {
          toValue: 0, useNativeDriver: true,
          tension: 65, friction: 12,
        }),
        Animated.timing(opacity, {
          toValue: 1, duration: 200, useNativeDriver: true,
        }),
      ]).start()
    } else {
      Animated.parallel([
        Animated.timing(slideY, {
          toValue: 600, duration: 250, useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0, duration: 200, useNativeDriver: true,
        }),
      ]).start()
    }
  }, [visible])

  const initials = profile?.name
    ? profile.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const menuItems: MenuItem[] = [
    {
      icon: 'person-outline',
      label: 'Edit profile',
      sublabel: 'Name, phone number',
      onPress: onClose,
    },
    {
      icon: 'notifications-outline',
      label: 'Notifications',
      sublabel: 'Ride updates, offers',
      onPress: onClose,
    },
    {
      icon: 'card-outline',
      label: 'Payment methods',
      sublabel: 'Cash, card',
      onPress: onClose,
    },
    {
      icon: 'time-outline',
      label: 'Ride history',
      sublabel: 'Past trips and receipts',
      onPress: onClose,
    },
    {
      icon: 'help-circle-outline',
      label: 'Help & support',
      sublabel: 'FAQ, contact us',
      onPress: onClose,
    },
  ]

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        {/* Backdrop */}
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[styles.backdrop, { opacity }]} />
        </TouchableWithoutFeedback>

        {/* Sheet */}
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>

          {/* Handle */}
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          {/* Profile header */}
          <View style={styles.profileHeader}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{profile?.name ?? 'Passenger'}</Text>
              <Text style={styles.profilePhone}>{profile?.phone ?? ''}</Text>
            </View>
            <TouchableOpacity style={styles.editBtn} onPress={onClose}>
              <Ionicons name="pencil-outline" size={16} color="#6B7280" />
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          {/* Menu items */}
          <View style={styles.menuList}>
            {menuItems.map((item, i) => (
              <TouchableOpacity
                key={i}
                style={styles.menuItem}
                onPress={item.onPress}
                activeOpacity={0.7}
              >
                <View style={styles.menuIconWrap}>
                  <Ionicons name={item.icon as any} size={20} color="#9CA3AF" />
                </View>
                <View style={styles.menuText}>
                  <Text style={styles.menuLabel}>{item.label}</Text>
                  {item.sublabel && (
                    <Text style={styles.menuSublabel}>{item.sublabel}</Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={16} color="#374151" />
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.divider} />

          {/* Sign out */}
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => { onClose(); onSignOut() }}
            activeOpacity={0.7}
          >
            <View style={[styles.menuIconWrap, styles.signOutIconWrap]}>
              <Ionicons name="log-out-outline" size={20} color="#F87171" />
            </View>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>

          <View style={{ height: Platform.OS === 'ios' ? 34 : 16 }} />
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  handleRow: { alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)' },

  profileHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16, gap: 14,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#1E3A5F',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#E8500A',
  },
  avatarText: { fontSize: 18, fontWeight: '700', color: '#93C5FD' },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 17, fontWeight: '600', color: '#F1F5F9' },
  profilePhone: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  editBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: '#1E2A3A',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },

  divider: { height: 0.5, backgroundColor: 'rgba(255,255,255,0.07)', marginHorizontal: 20 },

  menuList: { paddingVertical: 6 },
  menuItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12, gap: 14,
  },
  menuIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#1E2A3A',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 14, fontWeight: '500', color: '#F1F5F9' },
  menuSublabel: { fontSize: 12, color: '#6B7280', marginTop: 1 },

  signOutBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, gap: 14,
  },
  signOutIconWrap: {
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderColor: 'rgba(248,113,113,0.2)',
  },
  signOutText: { fontSize: 14, fontWeight: '500', color: '#F87171' },
})
