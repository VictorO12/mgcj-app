import React, { useRef, useState, useEffect } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  PanResponder, Dimensions, Platform, Linking, Alert,
} from 'react-native'
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps'
import { Ionicons } from '@expo/vector-icons'
import { ActiveRide } from '../hooks/useActiveRide'

const { height: SCREEN_HEIGHT } = Dimensions.get('window')
const FULL_HEIGHT = SCREEN_HEIGHT * 0.72

interface ActiveDriver {
  id: string
  current_lat: number
  current_lng: number
  name: string | null
  vehicle_make: string | null
}

interface Props {
  ride: ActiveRide
  eta: number | null
  statusLabel: string
  onCancel: () => void
  activeDrivers: ActiveDriver[]
}

export default function RideTrackingSheet({ ride, eta, statusLabel, onCancel, activeDrivers }: Props) {
  const [expanded, setExpanded] = useState(false)
  const sheetY = useRef(new Animated.Value(0)).current
  const mapRef = useRef<MapView>(null)

  const driverCoords = ride.driver?.current_lat && ride.driver?.current_lng
    ? { latitude: ride.driver.current_lat, longitude: ride.driver.current_lng }
    : null

  const pickupCoords = { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
  const dropoffCoords = { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }

  useEffect(() => {
    if (!expanded || !mapRef.current) return
    const coords = [pickupCoords, dropoffCoords]
    if (driverCoords) coords.push(driverCoords)
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 60, right: 40, bottom: 60, left: 40 },
      animated: true,
    })
  }, [expanded, driverCoords?.latitude, driverCoords?.longitude])

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
      onPanResponderRelease: (_, g) => {
        if (g.dy < -40) expand()
        else if (g.dy > 40) collapse()
      },
    })
  ).current

  function expand() {
    setExpanded(true)
    Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }).start()
  }

  function collapse() {
    setExpanded(false)
    Animated.spring(sheetY, { toValue: 0, useNativeDriver: true }).start()
  }

  function callDriver() {
    const phone = ride.driver?.phone
    if (!phone) return
    Linking.openURL(`tel:${phone}`)
  }

  function smsDriver() {
    const phone = ride.driver?.phone
    if (!phone) return
    Linking.openURL(`sms:${phone}`)
  }

  function handleCancel() {
    Alert.alert(
      'Cancel ride?',
      'Are you sure you want to cancel this ride?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Yes, cancel', style: 'destructive', onPress: onCancel },
      ]
    )
  }

  const isCompleted = ride.status === 'completed'
  const isCancelled = ride.status === 'cancelled'
  const isPending = ride.status === 'pending'
  const hasDriver = !!ride.driver

  const statusColor = isCompleted ? '#1D9E75'
    : isCancelled ? '#E24B4A'
    : isPending ? '#F59E0B'
    : '#E8500A'

  // ── MINIMIZED BAR ──────────────────────────────────────────
  if (!expanded) {
    return (
      <TouchableOpacity
        style={styles.miniBar}
        onPress={expand}
        activeOpacity={0.92}
        {...panResponder.panHandlers}
      >
        <View style={styles.miniLeft}>
          <View style={[styles.pulseDot, { backgroundColor: statusColor }]} />
          <View>
            <Text style={styles.miniStatus}>{statusLabel}</Text>
            <Text style={styles.miniSub}>
              {eta !== null ? `${eta} min away` : 'Calculating…'}
              {hasDriver ? ` · ${ride.driver!.name?.split(' ')[0]}` : ''}
            </Text>
          </View>
        </View>
        <View style={styles.miniRight}>
          <Text style={styles.miniEta}>{eta !== null ? `${eta}` : '--'}</Text>
          <Text style={styles.miniEtaLabel}>min</Text>
          <Ionicons name="chevron-up" size={16} color="#6B7280" style={{ marginLeft: 8 }} />
        </View>
      </TouchableOpacity>
    )
  }

  // ── EXPANDED SHEET ─────────────────────────────────────────
  return (
    <Animated.View style={[styles.fullSheet, { transform: [{ translateY: sheetY }] }]}>

      <View style={styles.dragHandle} {...panResponder.panHandlers}>
        <View style={styles.handleBar} />
      </View>

      <MapView
        ref={mapRef}
        style={styles.trackingMap}
        provider={PROVIDER_GOOGLE}
        customMapStyle={darkMapStyle}
        scrollEnabled={false}
        zoomEnabled={false}
      >
        {/* All active drivers */}
        {activeDrivers.map(d => (
          <Marker
            key={d.id}
            coordinate={{ latitude: d.current_lat, longitude: d.current_lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            title={d.name ?? 'Driver'}
            description={d.vehicle_make ?? ''}
          >
            <View style={[
              styles.driverMarker,
              ride.driver?.id === d.id && styles.driverMarkerMine,
            ]}>
              <Text style={styles.driverMarkerText}>🚗</Text>
            </View>
          </Marker>
        ))}

        {/* Route markers */}
        <Marker coordinate={pickupCoords} pinColor="#4a9eff" title="Pickup" />
        <Marker coordinate={dropoffCoords} pinColor="#E8500A" title="Drop-off" />

        {/* Dashed line from driver to pickup */}
        {driverCoords && (
          <Polyline
            coordinates={[driverCoords, pickupCoords]}
            strokeColor="#4a9eff"
            strokeWidth={2}
            lineDashPattern={[6, 4]}
          />
        )}
      </MapView>

      <View style={styles.sheetContent}>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
          <TouchableOpacity onPress={collapse} style={styles.collapseBtn}>
            <Ionicons name="chevron-down" size={20} color="#6B7280" />
          </TouchableOpacity>
        </View>

        <View style={styles.etaBanner}>
          <View>
            <Text style={styles.etaNum}>{eta !== null ? `${eta} min` : '—'}</Text>
            <Text style={styles.etaLabel}>
              {ride.status === 'in_progress' ? 'to destination' : 'until pickup'}
            </Text>
          </View>
          <View style={styles.routeSummary}>
            <Text style={styles.routeAddr} numberOfLines={1}>{ride.pickup_address}</Text>
            <Ionicons name="arrow-forward" size={12} color="#4B5563" />
            <Text style={styles.routeAddr} numberOfLines={1}>{ride.dropoff_address}</Text>
          </View>
        </View>

        {hasDriver && (
          <View style={styles.driverCard}>
            <View style={styles.driverAvatar}>
              <Text style={styles.driverInitials}>
                {ride.driver!.name?.split(' ').map(n => n[0]).join('').slice(0, 2) ?? 'D'}
              </Text>
            </View>
            <View style={styles.driverInfo}>
              <Text style={styles.driverName}>{ride.driver!.name ?? 'Your driver'}</Text>
              <Text style={styles.driverVehicle}>
                {ride.driver!.vehicle_make} {ride.driver!.vehicle_model} · {ride.driver!.plate_number}
              </Text>
            </View>
            <View style={styles.driverActions}>
              <TouchableOpacity style={styles.actionBtn} onPress={smsDriver}>
                <Ionicons name="chatbubble-outline" size={18} color="#CBD5E1" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={callDriver}>
                <Ionicons name="call-outline" size={18} color="#CBD5E1" />
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.bottomRow}>
          <View>
            <Text style={styles.fareLabel}>Estimated fare</Text>
            <Text style={styles.fareAmt}>
              ${ride.fare_final?.toFixed(2) ?? ride.fare_estimate?.toFixed(2) ?? '--'}
            </Text>
          </View>
          {!isCompleted && !isCancelled && (
            <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
              <Text style={styles.cancelText}>Cancel ride</Text>
            </TouchableOpacity>
          )}
          {isCompleted && (
            <View style={styles.completedBadge}>
              <Ionicons name="checkmark-circle" size={16} color="#1D9E75" />
              <Text style={styles.completedText}>Trip complete</Text>
            </View>
          )}
        </View>

      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  miniBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 80,
    backgroundColor: '#1E2A3A',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, justifyContent: 'space-between',
  },
  miniLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  pulseDot: { width: 10, height: 10, borderRadius: 5 },
  miniStatus: { fontSize: 14, fontWeight: '600', color: '#F1F5F9' },
  miniSub: { fontSize: 12, color: '#6B7280', marginTop: 1 },
  miniRight: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  miniEta: { fontSize: 24, fontWeight: '700', color: '#F1F5F9' },
  miniEtaLabel: { fontSize: 12, color: '#6B7280' },

  fullSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: FULL_HEIGHT,
    backgroundColor: '#111827',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  dragHandle: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  handleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)' },
  trackingMap: { height: FULL_HEIGHT * 0.38 },

  driverMarker: {
    backgroundColor: '#1E2A3A', borderRadius: 20, padding: 5,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.15)',
  },
  driverMarkerMine: { borderColor: '#E8500A', backgroundColor: '#2A1A0E' },
  driverMarkerText: { fontSize: 16 },

  sheetContent: { flex: 1, paddingHorizontal: 20, paddingTop: 14 },

  statusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 16, fontWeight: '600', color: '#F1F5F9', flex: 1 },
  collapseBtn: { padding: 4 },

  etaBanner: {
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  etaNum: { fontSize: 28, fontWeight: '700', color: '#F1F5F9' },
  etaLabel: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  routeSummary: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, marginLeft: 16 },
  routeAddr: { fontSize: 11, color: '#6B7280', flex: 1 },

  driverCard: {
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12,
  },
  driverAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#253D56', alignItems: 'center', justifyContent: 'center',
  },
  driverInitials: { fontSize: 15, fontWeight: '600', color: '#93C5FD' },
  driverInfo: { flex: 1 },
  driverName: { fontSize: 15, fontWeight: '600', color: '#F1F5F9' },
  driverVehicle: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  driverActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: '#253D56',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },

  bottomRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  fareLabel: { fontSize: 12, color: '#6B7280' },
  fareAmt: { fontSize: 22, fontWeight: '700', color: '#F1F5F9' },
  cancelBtn: {
    backgroundColor: 'rgba(226,75,74,0.12)', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 18,
    borderWidth: 0.5, borderColor: 'rgba(226,75,74,0.3)',
  },
  cancelText: { color: '#F87171', fontSize: 13, fontWeight: '500' },
  completedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(29,158,117,0.12)', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 16,
    borderWidth: 0.5, borderColor: 'rgba(29,158,117,0.3)',
  },
  completedText: { color: '#1D9E75', fontSize: 13, fontWeight: '500' },
})

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#1d2c3f' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#253d56' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
]
