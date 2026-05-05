import React, { useState, useEffect, useRef } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, Alert, Animated, StyleSheet as RNStyleSheet,
} from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'
import * as Location from 'expo-location'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../hooks/useAuth'
import RideRequestSheet from './RideRequestSheet'
import ProfileMenu from '../../components/ProfileMenu'
import RideHistoryScreen from '../shared/RideHistoryScreen'

interface PendingRide {
  id: string
  pickup_address: string
  dropoff_address: string
  pickup_lat: number
  pickup_lng: number
  dropoff_lat: number
  dropoff_lng: number
  fare_estimate: number | null
  passenger_name: string | null
  passenger_phone: string | null
}

interface LatLng { latitude: number; longitude: number }

const VALLEY_REGION = {
  latitude: 45.0773, longitude: -64.3601,
  latitudeDelta: 0.15, longitudeDelta: 0.15,
}

export default function DriverHomeScreen() {
  const { profile, signOut } = useAuth()
  const mapRef = useRef<MapView>(null)
  const pulseAnim = useRef(new Animated.Value(1)).current

  const [isOnline, setIsOnline] = useState(false)
  const [location, setLocation] = useState<LatLng | null>(null)
  const [pendingRide, setPendingRide] = useState<PendingRide | null>(null)
  const [togglingOnline, setTogglingOnline] = useState(false)
  const [menuVisible, setMenuVisible] = useState(false)
  const [historyVisible, setHistoryVisible] = useState(false)
  const locationInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!isOnline) return
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.4, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    ).start()
    return () => pulseAnim.stopAnimation()
  }, [isOnline])

  useEffect(() => {
    ;(async () => {
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status !== 'granted') {
        Alert.alert('Location required', 'Please enable location to go online.')
        return
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setLocation(coords)
      mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 800)
    })()
  }, [])

  useEffect(() => {
    if (!profile) return
    supabase
      .from('drivers').select('is_active').eq('id', profile.id).single()
      .then(({ data }) => { if (data) setIsOnline(data.is_active) })
  }, [profile])

  useEffect(() => {
    if (locationInterval.current) clearInterval(locationInterval.current)
    if (!isOnline || !profile) return
    locationInterval.current = setInterval(async () => {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setLocation(coords)
      await supabase.from('drivers').update({
        current_lat: coords.latitude, current_lng: coords.longitude,
        updated_at: new Date().toISOString(),
      }).eq('id', profile.id)
    }, 10000)
    return () => { if (locationInterval.current) clearInterval(locationInterval.current) }
  }, [isOnline, profile])

  useEffect(() => {
    if (!isOnline || !profile) return
    const channel = supabase
      .channel('pending-rides-' + profile.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rides' }, async (payload) => {
        const row = payload.new as any
        if (row.status !== 'pending') {
          setPendingRide(prev => prev?.id === row.id ? null : prev)
          return
        }
        await fetchPendingRide(row.id)
      })
      .subscribe()
    checkExistingPendingRides()
    return () => { supabase.removeChannel(channel) }
  }, [isOnline, profile])

  async function checkExistingPendingRides() {
    const { data } = await supabase
      .from('rides').select('id').eq('status', 'pending')
      .order('created_at', { ascending: true }).limit(1)
    if (data && data.length > 0) await fetchPendingRide(data[0].id)
  }

  async function fetchPendingRide(rideId: string) {
    const { data: ride } = await supabase
      .from('rides').select('*').eq('id', rideId).eq('status', 'pending').single()
    if (!ride) return
    const { data: passenger } = await supabase
      .from('profiles').select('name, phone').eq('id', ride.passenger_id).single()
    setPendingRide({
      id: ride.id,
      pickup_address: ride.pickup_address,
      dropoff_address: ride.dropoff_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_phone: passenger?.phone ?? null,
    })
  }

  async function toggleOnline() {
    if (!profile) return
    if (!location && !isOnline) {
      Alert.alert('Location unavailable', 'Please enable location services to go online.')
      return
    }
    setTogglingOnline(true)
    const goingOnline = !isOnline
    const update: any = { is_active: goingOnline }
    if (goingOnline && location) {
      update.current_lat = location.latitude
      update.current_lng = location.longitude
    } else if (!goingOnline) {
      update.current_lat = null
      update.current_lng = null
    }
    const { error } = await supabase.from('drivers').update(update).eq('id', profile.id)
    if (error) { Alert.alert('Error', error.message) }
    else { setIsOnline(goingOnline); if (!goingOnline) setPendingRide(null) }
    setTogglingOnline(false)
  }

  async function acceptRide() {
    if (!pendingRide || !profile) return
    const { error } = await supabase
      .from('rides')
      .update({ driver_id: profile.id, status: 'assigned' })
      .eq('id', pendingRide.id)
      .eq('status', 'pending')
    if (error) { Alert.alert('Ride unavailable', 'This ride was already taken.'); setPendingRide(null); return }
    setPendingRide(null)
  }

  async function declineRide() {
    setPendingRide(null)
    setTimeout(checkExistingPendingRides, 1000)
  }

  return (
    <View style={styles.container}>

      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={VALLEY_REGION}
        showsUserLocation
        showsMyLocationButton={false}
        customMapStyle={darkMapStyle}
      >
        {location && isOnline && (
          <Marker coordinate={location} anchor={{ x: 0.5, y: 0.5 }} title="You">
            <View style={styles.myMarker}>
              <Text style={{ fontSize: 18 }}>🚗</Text>
            </View>
          </Marker>
        )}
      </MapView>

      <View style={styles.topBar}>
        <View>
          <Text style={styles.topName}>{profile?.name?.split(' ')[0] ?? 'Driver'}</Text>
          <View style={styles.statusRow}>
            <Animated.View style={[
              styles.statusDot,
              { backgroundColor: isOnline ? '#1D9E75' : '#4B5563' },
              isOnline && { transform: [{ scale: pulseAnim }] },
            ]} />
            <Text style={styles.statusText}>
              {isOnline ? 'Online — accepting rides' : 'Offline'}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.avatarBtn} onPress={() => setMenuVisible(true)}>
          <Ionicons name="person-circle" size={36} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {location && (
        <TouchableOpacity
          style={styles.recenterBtn}
          onPress={() => mapRef.current?.animateToRegion(
            { ...location, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 600
          )}
        >
          <Ionicons name="locate" size={20} color="#F1F5F9" />
        </TouchableOpacity>
      )}

      <View style={styles.bottomSheet}>
        {isOnline ? (
          <View style={styles.onlineSheet}>
            <View style={styles.waitingRow}>
              <View style={styles.waitingIcon}>
                <Ionicons name="radio-outline" size={22} color="#1D9E75" />
              </View>
              <View>
                <Text style={styles.waitingTitle}>Waiting for a ride request</Text>
                <Text style={styles.waitingSubtitle}>You'll be notified when a passenger books</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.offlineBtn} onPress={toggleOnline} disabled={togglingOnline} activeOpacity={0.8}>
              <Text style={styles.offlineBtnText}>Go offline</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.offlineSheet}>
            <Text style={styles.offlineTitle}>You're offline</Text>
            <Text style={styles.offlineSubtitle}>
              Go online to start receiving ride requests in the Annapolis Valley.
            </Text>
            <TouchableOpacity
              style={[styles.onlineBtn, togglingOnline && { opacity: 0.6 }]}
              onPress={toggleOnline} disabled={togglingOnline} activeOpacity={0.85}
            >
              <Text style={styles.onlineBtnText}>
                {togglingOnline ? 'Connecting…' : 'Go online'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {pendingRide && isOnline && (
        <RideRequestSheet ride={pendingRide} onAccept={acceptRide} onDecline={declineRide} />
      )}

      {historyVisible && (
        <View style={StyleSheet.absoluteFill}>
          <RideHistoryScreen onClose={() => setHistoryVisible(false)} />
        </View>
      )}

      <ProfileMenu
        profile={profile}
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        onSignOut={signOut}
        onOpenHistory={() => setHistoryVisible(true)}
      />

    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  map: { flex: 1 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 56 : 40,
    paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: 'rgba(17,24,39,0.88)',
  },
  topName: { fontSize: 20, fontWeight: '700', color: '#F1F5F9', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: '#6B7280' },
  avatarBtn: { padding: 4 },
  recenterBtn: {
    position: 'absolute', right: 16, bottom: 220,
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#1E2A3A', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  myMarker: {
    backgroundColor: '#1E2A3A', borderRadius: 20, padding: 5,
    borderWidth: 1.5, borderColor: '#1D9E75',
  },
  bottomSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#111827', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20, paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 44 : 24,
  },
  onlineSheet: { gap: 16 },
  waitingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: '#1E2A3A', borderRadius: 16, padding: 16,
    borderWidth: 0.5, borderColor: 'rgba(29,158,117,0.25)',
  },
  waitingIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(29,158,117,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  waitingTitle: { fontSize: 14, fontWeight: '600', color: '#F1F5F9' },
  waitingSubtitle: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  offlineBtn: {
    backgroundColor: '#1E2A3A', borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  offlineBtnText: { color: '#9CA3AF', fontSize: 15, fontWeight: '500' },
  offlineSheet: { alignItems: 'center', paddingVertical: 10 },
  offlineTitle: { fontSize: 22, fontWeight: '700', color: '#F1F5F9', marginBottom: 8 },
  offlineSubtitle: {
    fontSize: 14, color: '#6B7280', textAlign: 'center',
    lineHeight: 20, marginBottom: 24, paddingHorizontal: 10,
  },
  onlineBtn: {
    backgroundColor: '#1D9E75', borderRadius: 14,
    paddingVertical: 15, paddingHorizontal: 48, alignItems: 'center',
  },
  onlineBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
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
