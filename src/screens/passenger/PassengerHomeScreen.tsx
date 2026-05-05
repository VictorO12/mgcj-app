import React, { useState, useEffect, useRef } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, ActivityIndicator,
  Platform, Alert, StyleSheet as RNStyleSheet,
} from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'
import * as Location from 'expo-location'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../hooks/useAuth'
import { useActiveRide } from '../../hooks/useActiveRide'
import { supabase } from '../../lib/supabase'
import RideTrackingSheet from '../../components/RideTrackingSheet'
import ProfileMenu from '../../components/ProfileMenu'
import RideHistoryScreen from '../shared/RideHistoryScreen'
import Constants from 'expo-constants'

const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey

const QUICK_DESTINATIONS = [
  { label: '🏥 Valley Hospital', address: 'Valley Regional Hospital, Kentville, NS' },
  { label: '🛒 Superstore', address: 'Atlantic Superstore, New Minas, NS' },
  { label: '🎓 Acadia', address: 'Acadia University, Wolfville, NS' },
  { label: '💊 Pharmasave', address: 'Pharmasave, Kentville, NS' },
]

interface PlacePrediction { place_id: string; description: string }
interface LatLng { latitude: number; longitude: number }
interface ActiveDriver {
  id: string
  current_lat: number
  current_lng: number
  name: string | null
  vehicle_make: string | null
}

const VALLEY_REGION = {
  latitude: 45.0773, longitude: -64.3601,
  latitudeDelta: 0.15, longitudeDelta: 0.15,
}

export default function PassengerHomeScreen() {
  const { profile, signOut } = useAuth()
  const { ride, eta, statusLabel } = useActiveRide(profile?.id)
  const mapRef = useRef<MapView>(null)

  const [userLocation, setUserLocation] = useState<LatLng | null>(null)
  const [pickupCoords, setPickupCoords] = useState<LatLng | null>(null)
  const [dropoffCoords, setDropoffCoords] = useState<LatLng | null>(null)
  const [pickupText, setPickupText] = useState('My location')
  const [dropoffText, setDropoffText] = useState('')
  const [activeField, setActiveField] = useState<'pickup' | 'dropoff' | null>(null)
  const [predictions, setPredictions] = useState<PlacePrediction[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [fareEstimate, setFareEstimate] = useState<number | null>(null)
  const [fareLoading, setFareLoading] = useState(false)
  const [bookingLoading, setBookingLoading] = useState(false)
  const [sheet, setSheet] = useState<'search' | 'confirm' | null>(null)
  const [activeDrivers, setActiveDrivers] = useState<ActiveDriver[]>([])
  const [menuVisible, setMenuVisible] = useState(false)
  const [historyVisible, setHistoryVisible] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status !== 'granted') return
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setUserLocation(coords)
      setPickupCoords(coords)
      mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 800)
      const [place] = await Location.reverseGeocodeAsync(coords)
      if (place) setPickupText([place.name, place.street].filter(Boolean).join(', ') || 'My location')
    })()
  }, [])

  useEffect(() => {
    fetchActiveDrivers()
    const interval = setInterval(fetchActiveDrivers, 15000)
    return () => clearInterval(interval)
  }, [])

  async function fetchActiveDrivers() {
    const { data } = await supabase
      .from('drivers')
      .select('id, current_lat, current_lng, vehicle_make')
      .eq('is_active', true)
      .not('current_lat', 'is', null)
    if (!data) return
    const withNames = await Promise.all(
      data.map(async (d) => {
        const { data: p } = await supabase
          .from('profiles').select('name').eq('id', d.id).single()
        return { ...d, name: p?.name ?? null }
      })
    )
    setActiveDrivers(withNames.filter(d => d.current_lat && d.current_lng) as ActiveDriver[])
  }

  async function searchPlaces(query: string) {
    if (query.length < 3) { setPredictions([]); return }
    setSearchLoading(true)
    try {
      const loc = userLocation
        ? `&location=${userLocation.latitude},${userLocation.longitude}&radius=30000`
        : ''
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&key=${MAPS_KEY}&components=country:ca${loc}`
      )
      setPredictions((await res.json()).predictions ?? [])
    } catch (e) { console.error(e) }
    setSearchLoading(false)
  }

  async function selectPlace(prediction: PlacePrediction) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${prediction.place_id}&fields=geometry&key=${MAPS_KEY}`
      )
      const loc = (await res.json()).result?.geometry?.location
      if (!loc) return
      const coords = { latitude: loc.lat, longitude: loc.lng }
      if (activeField === 'pickup') {
        setPickupCoords(coords)
        setPickupText(prediction.description.split(',')[0])
      } else {
        setDropoffCoords(coords)
        setDropoffText(prediction.description.split(',')[0])
      }
      setPredictions([])
      setActiveField(null)
      const pickup = activeField === 'pickup' ? coords : pickupCoords
      const dropoff = activeField === 'dropoff' ? coords : dropoffCoords
      if (pickup && dropoff) {
        setSheet('confirm')
        getFareEstimate(pickup, dropoff)
        mapRef.current?.fitToCoordinates([pickup, dropoff], {
          edgePadding: { top: 80, right: 60, bottom: 380, left: 60 }, animated: true,
        })
      }
    } catch (e) { console.error(e) }
  }

  async function getFareEstimate(pickup: LatLng, dropoff: LatLng) {
    setFareLoading(true)
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.latitude},${pickup.longitude}&destination=${dropoff.latitude},${dropoff.longitude}&key=${MAPS_KEY}`
      )
      const metres = (await res.json()).routes?.[0]?.legs?.[0]?.distance?.value ?? 0
      setFareEstimate(Math.round((4 + (metres / 1000) * 1.8) * 100) / 100)
    } catch (e) { console.error(e) }
    setFareLoading(false)
  }

  async function confirmBooking() {
    if (!pickupCoords || !dropoffCoords || !profile) {
      Alert.alert('Missing info', 'Please set both pickup and dropoff.')
      return
    }
    setBookingLoading(true)
    const { error } = await supabase.from('rides').insert({
      passenger_id: profile.id,
      status: 'pending',
      pickup_address: pickupText,
      pickup_lat: pickupCoords.latitude,
      pickup_lng: pickupCoords.longitude,
      dropoff_address: dropoffText,
      dropoff_lat: dropoffCoords.latitude,
      dropoff_lng: dropoffCoords.longitude,
      fare_estimate: fareEstimate,
      payment_method: 'cash',
    }).select().single()
    setBookingLoading(false)
    if (error) { Alert.alert('Booking failed', error.message); return }
    resetBookingUI()
  }

  async function cancelRide() {
    if (!ride) return
    await supabase.from('rides').update({ status: 'cancelled' }).eq('id', ride.id)
  }

  function resetBookingUI() {
    setDropoffText(''); setDropoffCoords(null)
    setFareEstimate(null); setSheet(null)
    setPredictions([]); setActiveField(null)
    if (userLocation)
      mapRef.current?.animateToRegion(
        { ...userLocation, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 600
      )
  }

  const hasActiveRide = !!ride
  const myDriverId = ride?.driver?.id

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
        {activeDrivers.map(d => (
          <Marker
            key={d.id}
            coordinate={{ latitude: d.current_lat, longitude: d.current_lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            title={d.name ?? 'Driver'}
            description={d.vehicle_make ?? ''}
          >
            <View style={[styles.driverMarker, myDriverId === d.id && styles.driverMarkerMine]}>
              <Text style={styles.driverMarkerText}>🚗</Text>
            </View>
          </Marker>
        ))}
        {!hasActiveRide && pickupCoords && pickupText !== 'My location' && (
          <Marker coordinate={pickupCoords} pinColor="#4a9eff" title="Pickup" />
        )}
        {!hasActiveRide && dropoffCoords && (
          <Marker coordinate={dropoffCoords} pinColor="#E8500A" title="Drop-off" />
        )}
      </MapView>

      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.topName}>
            {hasActiveRide ? 'Your ride' : `Hey ${profile?.name?.split(' ')[0] ?? 'there'}`}
          </Text>
          <Text style={styles.topSub}>
            {hasActiveRide ? statusLabel(ride.status, ride.driver?.name) : 'Where are you headed?'}
          </Text>
        </View>
        <TouchableOpacity style={styles.avatarBtn} onPress={() => setMenuVisible(true)}>
          <Ionicons name="person-circle" size={36} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {activeDrivers.length > 0 && (
        <View style={styles.driversPill}>
          <View style={styles.driversPillDot} />
          <Text style={styles.driversPillText}>
            {activeDrivers.length} driver{activeDrivers.length > 1 ? 's' : ''} nearby
          </Text>
        </View>
      )}

      {userLocation && (
        <TouchableOpacity
          style={styles.recenterBtn}
          onPress={() => mapRef.current?.animateToRegion(
            { ...userLocation, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 600
          )}
        >
          <Ionicons name="locate" size={20} color="#F1F5F9" />
        </TouchableOpacity>
      )}

      {!hasActiveRide && (
        <View style={styles.sheet}>
          <View style={styles.inputsCard}>
            <TouchableOpacity
              style={styles.inputRow}
              onPress={() => { setActiveField('pickup'); setSheet('search') }}
              activeOpacity={0.8}
            >
              <View style={[styles.inputDot, { backgroundColor: '#4a9eff' }]} />
              <Text style={[styles.inputText, !pickupText && styles.placeholder]} numberOfLines={1}>
                {pickupText || 'Pickup location'}
              </Text>
            </TouchableOpacity>
            <View style={styles.inputDivider} />
            <TouchableOpacity
              style={styles.inputRow}
              onPress={() => { setActiveField('dropoff'); setSheet('search') }}
              activeOpacity={0.8}
            >
              <View style={[styles.inputDot, { backgroundColor: '#E8500A', borderRadius: 3 }]} />
              <Text style={[styles.inputText, !dropoffText && styles.placeholder]} numberOfLines={1}>
                {dropoffText || 'Where to?'}
              </Text>
            </TouchableOpacity>
          </View>

          {sheet === 'search' && (
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color="#6B7280" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                placeholder={activeField === 'pickup' ? 'Search pickup...' : 'Search destination...'}
                placeholderTextColor="#6B7280"
                autoFocus
                onChangeText={t => {
                  activeField === 'dropoff' ? setDropoffText(t) : setPickupText(t)
                  searchPlaces(t)
                }}
                value={activeField === 'dropoff' ? dropoffText : pickupText}
              />
              {searchLoading && <ActivityIndicator size="small" color="#E8500A" />}
              <TouchableOpacity onPress={() => { setSheet(null); setActiveField(null); setPredictions([]) }}>
                <Ionicons name="close" size={18} color="#6B7280" />
              </TouchableOpacity>
            </View>
          )}

          {predictions.length > 0 && (
            <ScrollView style={styles.predictionsList} keyboardShouldPersistTaps="handled">
              {predictions.map(p => (
                <TouchableOpacity key={p.place_id} style={styles.predictionRow} onPress={() => selectPlace(p)}>
                  <Ionicons name="location-outline" size={16} color="#6B7280" style={{ marginRight: 10 }} />
                  <Text style={styles.predictionText} numberOfLines={2}>{p.description}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {sheet === null && predictions.length === 0 && (
            <>
              <Text style={styles.sectionLabel}>QUICK DESTINATIONS</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {QUICK_DESTINATIONS.map(d => (
                  <TouchableOpacity
                    key={d.label} style={styles.quickChip}
                    onPress={() => {
                      setDropoffText(d.label.replace(/^.{2}/, '').trim())
                      setActiveField('dropoff')
                      searchPlaces(d.address)
                      setSheet('search')
                    }}
                  >
                    <Text style={styles.quickChipText}>{d.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}

          {sheet === 'confirm' && (
            <View>
              <Text style={styles.confirmTitle}>Confirm your ride</Text>
              <View style={styles.routeCard}>
                <View style={styles.routeRow}>
                  <View style={[styles.routeDot, { backgroundColor: '#4a9eff' }]} />
                  <Text style={styles.routeText} numberOfLines={1}>{pickupText}</Text>
                </View>
                <View style={styles.routeLine} />
                <View style={styles.routeRow}>
                  <View style={[styles.routeDot, { backgroundColor: '#E8500A', borderRadius: 3 }]} />
                  <Text style={styles.routeText} numberOfLines={1}>{dropoffText}</Text>
                </View>
              </View>
              <View style={styles.fareRow}>
                <View>
                  <Text style={styles.fareLabel}>Estimated fare</Text>
                  <Text style={styles.fareNote}>Cash · Subject to final distance</Text>
                </View>
                {fareLoading
                  ? <ActivityIndicator color="#E8500A" />
                  : <Text style={styles.fareAmount}>${fareEstimate?.toFixed(2) ?? '--'}</Text>
                }
              </View>
              <View style={styles.confirmBtns}>
                <TouchableOpacity style={styles.editBtn} onPress={resetBookingUI}>
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.bookBtn, bookingLoading && { opacity: 0.6 }]}
                  onPress={confirmBooking} disabled={bookingLoading}
                >
                  {bookingLoading
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={styles.bookBtnText}>Book ride</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {hasActiveRide && (
        <RideTrackingSheet
          ride={ride}
          eta={eta}
          statusLabel={statusLabel(ride.status, ride.driver?.name)}
          onCancel={cancelRide}
          activeDrivers={activeDrivers}
        />
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
  topName: { fontSize: 20, fontWeight: '700', color: '#F1F5F9' },
  topSub: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  avatarBtn: { padding: 4 },
  driversPill: {
    position: 'absolute', top: Platform.OS === 'ios' ? 110 : 96, left: 20,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(30,42,58,0.92)', borderRadius: 20,
    paddingVertical: 5, paddingHorizontal: 12,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  driversPillDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#1D9E75' },
  driversPillText: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  recenterBtn: {
    position: 'absolute', right: 16, bottom: 320,
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#1E2A3A', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  driverMarker: {
    backgroundColor: '#1E2A3A', borderRadius: 20, padding: 5,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.15)',
  },
  driverMarkerMine: { borderColor: '#E8500A', backgroundColor: '#2A1A0E' },
  driverMarkerText: { fontSize: 16 },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#111827', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36, minHeight: 280,
  },
  inputsCard: {
    backgroundColor: '#1E2A3A', borderRadius: 16,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 14, overflow: 'hidden',
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  inputDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  inputDivider: { height: 0.5, backgroundColor: 'rgba(255,255,255,0.07)', marginHorizontal: 16 },
  inputText: { fontSize: 15, color: '#F1F5F9', flex: 1 },
  placeholder: { color: '#4B5563' },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E2A3A', borderRadius: 12,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#F1F5F9' },
  predictionsList: { maxHeight: 220 },
  predictionRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  predictionText: { fontSize: 13, color: '#CBD5E1', flex: 1, lineHeight: 18 },
  sectionLabel: { fontSize: 10, fontWeight: '600', color: '#374151', letterSpacing: 0.08, marginBottom: 10, marginTop: 4 },
  quickChip: {
    backgroundColor: '#1E2A3A', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  quickChipText: { fontSize: 13, color: '#CBD5E1' },
  confirmTitle: { fontSize: 20, fontWeight: '700', color: '#F1F5F9', marginBottom: 16 },
  routeCard: {
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 16,
  },
  routeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  routeDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  routeLine: { width: 1, height: 14, backgroundColor: 'rgba(255,255,255,0.12)', marginLeft: 4.5, marginVertical: 2 },
  routeText: { fontSize: 14, color: '#CBD5E1', flex: 1 },
  fareRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#1E2A3A', borderRadius: 14, padding: 16,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 20,
  },
  fareLabel: { fontSize: 14, color: '#9CA3AF', marginBottom: 3 },
  fareNote: { fontSize: 11, color: '#4B5563' },
  fareAmount: { fontSize: 28, fontWeight: '700', color: '#F1F5F9' },
  confirmBtns: { flexDirection: 'row', gap: 12 },
  editBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#1E2A3A', alignItems: 'center',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  editBtnText: { color: '#9CA3AF', fontSize: 15, fontWeight: '500' },
  bookBtn: { flex: 2, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E8500A', alignItems: 'center' },
  bookBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
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
