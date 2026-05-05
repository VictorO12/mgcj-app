import React, { useEffect, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, Linking, Alert, ActivityIndicator,
} from 'react-native'
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps'
import * as Location from 'expo-location'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import Constants from 'expo-constants'

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey

interface ActiveRide {
  id: string
  status: string
  pickup_address: string
  pickup_lat: number
  pickup_lng: number
  dropoff_address: string
  dropoff_lat: number
  dropoff_lng: number
  fare_estimate: number | null
  passenger_name: string | null
  passenger_phone: string | null
}

interface LatLng { latitude: number; longitude: number }

interface Props {
  ride: ActiveRide
  onRideComplete: () => void
}

export default function DriverActiveRideScreen({ ride, onRideComplete }: Props) {
  const { profile } = useAuth()
  const mapRef = useRef<MapView>(null)
  const [location, setLocation] = useState<LatLng | null>(null)
  const [eta, setEta] = useState<number | null>(null)
  const [updating, setUpdating] = useState(false)
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const etaInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  const isPickingUp = ride.status === 'assigned' || ride.status === 'driver_arriving'
  const target = isPickingUp
    ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
    : { latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }

  const statusLabel = () => {
    switch (ride.status) {
      case 'assigned': return 'Head to pickup'
      case 'driver_arriving': return 'Arriving at pickup'
      case 'in_progress': return 'Dropping off passenger'
      default: return 'Active ride'
    }
  }

  const nextActionLabel = () => {
    switch (ride.status) {
      case 'assigned': return "I've arrived at pickup"
      case 'driver_arriving': return 'Start ride'
      case 'in_progress': return 'Complete ride'
      default: return 'Next'
    }
  }

  const nextStatus = () => {
    switch (ride.status) {
      case 'assigned': return 'driver_arriving'
      case 'driver_arriving': return 'in_progress'
      case 'in_progress': return 'completed'
      default: return null
    }
  }

  // ── Track location and update Supabase ──────────────────────
  useEffect(() => {
    ;(async () => {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setLocation(coords)
      fitMap(coords)
    })()

    locationInterval.current = setInterval(async () => {
      if (!profile) return
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setLocation(coords)
      await supabase.from('drivers').update({
        current_lat: coords.latitude,
        current_lng: coords.longitude,
        updated_at: new Date().toISOString(),
      }).eq('id', profile.id)
    }, 10000)

    return () => {
      if (locationInterval.current) clearInterval(locationInterval.current)
      if (etaInterval.current) clearInterval(etaInterval.current)
    }
  }, [])

  // ── Recalculate ETA when location or target changes ─────────
  useEffect(() => {
    if (!location) return
    calculateEta(location)
    if (etaInterval.current) clearInterval(etaInterval.current)
    etaInterval.current = setInterval(() => {
      if (location) calculateEta(location)
    }, 30000)
  }, [location?.latitude, location?.longitude, ride.status])

  function fitMap(driverCoords: LatLng) {
    mapRef.current?.fitToCoordinates([driverCoords, target], {
      edgePadding: { top: 80, right: 60, bottom: 320, left: 60 },
      animated: true,
    })
  }

  async function calculateEta(from: LatLng) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${from.latitude},${from.longitude}` +
        `&destination=${target.latitude},${target.longitude}` +
        `&key=${MAPS_KEY}`
      )
      const json = await res.json()
      const seconds = json.routes?.[0]?.legs?.[0]?.duration?.value
      setEta(seconds ? Math.ceil(seconds / 60) : null)
    } catch (e) { console.error('[DriverETA]', e) }
  }

  async function advanceStatus() {
    const next = nextStatus()
    if (!next) return
    setUpdating(true)

    if (next === 'completed') {
      Alert.alert(
        'Complete ride?',
        `Confirm the trip to ${ride.dropoff_address} is complete.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setUpdating(false) },
          {
            text: 'Complete',
            onPress: async () => {
              await supabase.from('rides').update({
                status: 'completed',
                fare_final: ride.fare_estimate,
              }).eq('id', ride.id)
              setUpdating(false)
              onRideComplete()
            }
          }
        ]
      )
      return
    }

    await supabase.from('rides').update({ status: next }).eq('id', ride.id)
    setUpdating(false)
  }

  function openNavigation() {
    const url = Platform.OS === 'ios'
      ? `maps://?daddr=${target.latitude},${target.longitude}`
      : `google.navigation:q=${target.latitude},${target.longitude}`
    Linking.openURL(url).catch(() => {
      Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&destination=${target.latitude},${target.longitude}`
      )
    })
  }

  function callPassenger() {
    if (!ride.passenger_phone) return
    Linking.openURL(`tel:${ride.passenger_phone}`)
  }

  function smsPassenger() {
    if (!ride.passenger_phone) return
    Linking.openURL(`sms:${ride.passenger_phone}`)
  }

  return (
    <View style={styles.container}>

      {/* ── MAP ── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        customMapStyle={darkMapStyle}
        showsUserLocation
        showsMyLocationButton={false}
      >
        {location && (
          <Marker coordinate={location} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.driverMarker}>
              <Text style={{ fontSize: 18 }}>🚗</Text>
            </View>
          </Marker>
        )}
        <Marker
          coordinate={{ latitude: ride.pickup_lat, longitude: ride.pickup_lng }}
          pinColor="#4a9eff"
          title="Pickup"
        />
        <Marker
          coordinate={{ latitude: ride.dropoff_lat, longitude: ride.dropoff_lng }}
          pinColor="#E8500A"
          title="Drop-off"
        />
        {location && (
          <Polyline
            coordinates={[location, target]}
            strokeColor={isPickingUp ? '#4a9eff' : '#E8500A'}
            strokeWidth={2.5}
            lineDashPattern={[6, 4]}
          />
        )}
      </MapView>

      {/* ── TOP STATUS BAR ── */}
      <View style={styles.topBar}>
        <View style={styles.statusBadge}>
          <View style={[styles.statusDot, {
            backgroundColor: isPickingUp ? '#4a9eff' : '#E8500A'
          }]} />
          <Text style={styles.statusLabel}>{statusLabel()}</Text>
        </View>
        {eta !== null && (
          <View style={styles.etaBadge}>
            <Text style={styles.etaText}>{eta} min</Text>
          </View>
        )}
      </View>

      {/* ── NAVIGATE BUTTON ── */}
      <TouchableOpacity style={styles.navBtn} onPress={openNavigation}>
        <Ionicons name="navigate" size={20} color="#fff" />
        <Text style={styles.navBtnText}>Navigate</Text>
      </TouchableOpacity>

      {/* ── BOTTOM SHEET ── */}
      <View style={styles.sheet}>

        {/* Destination */}
        <View style={styles.destinationCard}>
          <View style={styles.destIcon}>
            <Ionicons
              name={isPickingUp ? 'location' : 'flag'}
              size={18}
              color={isPickingUp ? '#4a9eff' : '#E8500A'}
            />
          </View>
          <View style={styles.destText}>
            <Text style={styles.destLabel}>
              {isPickingUp ? 'Pickup location' : 'Drop-off location'}
            </Text>
            <Text style={styles.destAddress} numberOfLines={1}>
              {isPickingUp ? ride.pickup_address : ride.dropoff_address}
            </Text>
          </View>
          <Text style={styles.etaLarge}>{eta !== null ? `${eta}m` : '--'}</Text>
        </View>

        {/* Passenger card */}
        <View style={styles.passengerCard}>
          <View style={styles.passengerAvatar}>
            <Text style={styles.passengerInitials}>
              {ride.passenger_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() ?? '?'}
            </Text>
          </View>
          <View style={styles.passengerInfo}>
            <Text style={styles.passengerName}>{ride.passenger_name ?? 'Passenger'}</Text>
            <Text style={styles.fareText}>
              Est. fare: ${ride.fare_estimate?.toFixed(2) ?? '--'}
            </Text>
          </View>
          <View style={styles.contactBtns}>
            <TouchableOpacity style={styles.contactBtn} onPress={smsPassenger}>
              <Ionicons name="chatbubble-outline" size={18} color="#CBD5E1" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.contactBtn} onPress={callPassenger}>
              <Ionicons name="call-outline" size={18} color="#CBD5E1" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Action button */}
        <TouchableOpacity
          style={[styles.actionBtn, updating && { opacity: 0.6 }]}
          onPress={advanceStatus}
          disabled={updating}
          activeOpacity={0.85}
        >
          {updating
            ? <ActivityIndicator color="#fff" />
            : <>
                <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                <Text style={styles.actionBtnText}>{nextActionLabel()}</Text>
              </>
          }
        </TouchableOpacity>

      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  map: { flex: 1 },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 56 : 40,
    paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: 'rgba(17,24,39,0.88)',
  },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1E2A3A', borderRadius: 20,
    paddingVertical: 6, paddingHorizontal: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 13, fontWeight: '600', color: '#F1F5F9' },
  etaBadge: {
    backgroundColor: '#1E2A3A', borderRadius: 20,
    paddingVertical: 6, paddingHorizontal: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  etaText: { fontSize: 13, fontWeight: '700', color: '#F1F5F9' },

  navBtn: {
    position: 'absolute',
    right: 16,
    bottom: 310,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#1A2332',
    borderRadius: 20, paddingVertical: 10, paddingHorizontal: 16,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  navBtnText: { fontSize: 13, fontWeight: '500', color: '#fff' },

  driverMarker: {
    backgroundColor: '#1E2A3A', borderRadius: 20, padding: 5,
    borderWidth: 1.5, borderColor: '#1D9E75',
  },

  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#111827',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20, paddingTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 44 : 24,
    gap: 12,
  },

  destinationCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  destIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#111827',
    alignItems: 'center', justifyContent: 'center',
  },
  destText: { flex: 1 },
  destLabel: { fontSize: 11, color: '#6B7280' },
  destAddress: { fontSize: 14, fontWeight: '600', color: '#F1F5F9', marginTop: 2 },
  etaLarge: { fontSize: 22, fontWeight: '700', color: '#F1F5F9' },

  passengerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  passengerAvatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#1E3A5F',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(74,158,255,0.3)',
  },
  passengerInitials: { fontSize: 14, fontWeight: '700', color: '#93C5FD' },
  passengerInfo: { flex: 1 },
  passengerName: { fontSize: 15, fontWeight: '600', color: '#F1F5F9' },
  fareText: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  contactBtns: { flexDirection: 'row', gap: 8 },
  contactBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#253D56',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },

  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: '#E8500A',
    borderRadius: 14, paddingVertical: 15,
  },
  actionBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
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
