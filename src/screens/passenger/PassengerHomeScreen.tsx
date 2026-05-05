import React, { useState, useEffect, useRef } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, ActivityIndicator,
  Dimensions, Platform, Alert,
} from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'
import * as Location from 'expo-location'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import Constants from 'expo-constants'

const { height: SCREEN_HEIGHT } = Dimensions.get('window')
const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey

const QUICK_DESTINATIONS = [
  { label: '🏥 Valley Hospital', address: 'Valley Regional Hospital, Kentville, NS' },
  { label: '🛒 Superstore', address: 'Atlantic Superstore, New Minas, NS' },
  { label: '🎓 Acadia', address: 'Acadia University, Wolfville, NS' },
  { label: '💊 Pharmasave', address: 'Pharmasave, Kentville, NS' },
]

interface PlacePrediction {
  place_id: string
  description: string
}

interface LatLng {
  latitude: number
  longitude: number
}

// Annapolis Valley default center
const VALLEY_REGION = {
  latitude: 45.0773,
  longitude: -64.3601,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
}

export default function PassengerHomeScreen() {
  const { profile, signOut } = useAuth()
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

  const [sheet, setSheet] = useState<'search' | 'confirm' | 'booked' | null>(null)

  // ── Get user location on mount ──
  useEffect(() => {
    ;(async () => {
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status !== 'granted') return
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
      setUserLocation(coords)
      setPickupCoords(coords)
      mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 800)

      // Reverse geocode pickup label
      const [place] = await Location.reverseGeocodeAsync(coords)
      if (place) {
        const label = [place.name, place.street].filter(Boolean).join(', ')
        setPickupText(label || 'My location')
      }
    })()
  }, [])

  // ── Places autocomplete ──
  async function searchPlaces(query: string) {
    if (query.length < 3) { setPredictions([]); return }
    setSearchLoading(true)
    try {
      const loc = userLocation ? `&location=${userLocation.latitude},${userLocation.longitude}&radius=30000` : ''
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&key=${MAPS_KEY}&components=country:ca${loc}`
      )
      const json = await res.json()
      setPredictions(json.predictions ?? [])
    } catch (e) {
      console.error(e)
    }
    setSearchLoading(false)
  }

  async function selectPlace(prediction: PlacePrediction) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${prediction.place_id}&fields=geometry&key=${MAPS_KEY}`
      )
      const json = await res.json()
      const loc = json.result?.geometry?.location
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

      // If both set, get fare and show confirm sheet
      const pickup = activeField === 'pickup' ? coords : pickupCoords
      const dropoff = activeField === 'dropoff' ? coords : dropoffCoords
      if (pickup && dropoff) {
        setSheet('confirm')
        getFareEstimate(pickup, dropoff)
        fitMapToMarkers(pickup, dropoff)
      }
    } catch (e) {
      console.error(e)
    }
  }

  function fitMapToMarkers(a: LatLng, b: LatLng) {
    mapRef.current?.fitToCoordinates([a, b], {
      edgePadding: { top: 80, right: 60, bottom: 360, left: 60 },
      animated: true,
    })
  }

  // ── Fare estimate via Directions API ──
  async function getFareEstimate(pickup: LatLng, dropoff: LatLng) {
    setFareLoading(true)
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.latitude},${pickup.longitude}&destination=${dropoff.latitude},${dropoff.longitude}&key=${MAPS_KEY}`
      )
      const json = await res.json()
      const metres = json.routes?.[0]?.legs?.[0]?.distance?.value ?? 0
      const km = metres / 1000
      // M&G C&J style pricing: $4 base + $1.80/km
      const fare = 4 + km * 1.8
      setFareEstimate(Math.round(fare * 100) / 100)
    } catch (e) {
      console.error(e)
    }
    setFareLoading(false)
  }

  // ── Book the ride ──
  async function confirmBooking() {
    if (!pickupCoords || !dropoffCoords || !profile) return
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
    })
    setBookingLoading(false)
    if (error) { Alert.alert('Error', error.message); return }
    setSheet('booked')
  }

  function resetBooking() {
    setDropoffText('')
    setDropoffCoords(null)
    setFareEstimate(null)
    setSheet(null)
    setPredictions([])
    setActiveField(null)
    if (userLocation) {
      mapRef.current?.animateToRegion({ ...userLocation, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 600)
    }
  }

  return (
    <View style={styles.container}>

      {/* ── MAP ── */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={VALLEY_REGION}
        showsUserLocation
        showsMyLocationButton={false}
        customMapStyle={darkMapStyle}
      >
        {pickupCoords && pickupText !== 'My location' && (
          <Marker coordinate={pickupCoords} pinColor="#4a9eff" title="Pickup" />
        )}
        {dropoffCoords && (
          <Marker coordinate={dropoffCoords} pinColor="#E8500A" title="Drop-off" />
        )}
      </MapView>

      {/* ── TOP BAR ── */}
      <View style={styles.topBar}>
        <View style={styles.topGreeting}>
          <Text style={styles.topName}>Hey {profile?.name?.split(' ')[0] ?? 'there'} 👋</Text>
          <Text style={styles.topSub}>Where are you headed?</Text>
        </View>
        <TouchableOpacity style={styles.avatarBtn} onPress={signOut}>
          <Ionicons name="person-circle" size={36} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* ── RECENTER BUTTON ── */}
      {userLocation && (
        <TouchableOpacity
          style={styles.recenterBtn}
          onPress={() => mapRef.current?.animateToRegion({ ...userLocation, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 600)}
        >
          <Ionicons name="locate" size={20} color="#F1F5F9" />
        </TouchableOpacity>
      )}

      {/* ── BOTTOM SHEET ── */}
      <View style={styles.sheet}>

        {/* Search state */}
        {(sheet === null || sheet === 'search') && (
          <>
            {/* Input fields */}
            <View style={styles.inputsCard}>
              <TouchableOpacity
                style={styles.inputRow}
                onPress={() => { setActiveField('pickup'); setSheet('search') }}
                activeOpacity={0.8}
              >
                <View style={[styles.inputDot, { backgroundColor: '#4a9eff' }]} />
                <Text style={[styles.inputText, !pickupText && styles.inputPlaceholder]} numberOfLines={1}>
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
                <Text style={[styles.inputText, !dropoffText && styles.inputPlaceholder]} numberOfLines={1}>
                  {dropoffText || 'Where to?'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Active search box */}
            {sheet === 'search' && (
              <View style={styles.searchBox}>
                <Ionicons name="search" size={16} color="#6B7280" style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchInput}
                  placeholder={activeField === 'pickup' ? 'Search pickup...' : 'Search destination...'}
                  placeholderTextColor="#6B7280"
                  autoFocus
                  onChangeText={t => {
                    if (activeField === 'dropoff') setDropoffText(t)
                    else setPickupText(t)
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

            {/* Predictions list */}
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

            {/* Quick destinations */}
            {sheet === null && predictions.length === 0 && (
              <>
                <Text style={styles.sectionLabel}>QUICK DESTINATIONS</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickRow}>
                  {QUICK_DESTINATIONS.map(d => (
                    <TouchableOpacity
                      key={d.label}
                      style={styles.quickChip}
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
          </>
        )}

        {/* Confirm state */}
        {sheet === 'confirm' && (
          <View style={styles.confirmSheet}>
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
                <Text style={styles.fareNote}>Cash payment • Subject to final distance</Text>
              </View>
              {fareLoading
                ? <ActivityIndicator color="#E8500A" />
                : <Text style={styles.fareAmount}>${fareEstimate?.toFixed(2) ?? '--'}</Text>
              }
            </View>

            <View style={styles.confirmBtns}>
              <TouchableOpacity style={styles.editBtn} onPress={resetBooking}>
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bookBtn, bookingLoading && { opacity: 0.6 }]}
                onPress={confirmBooking}
                disabled={bookingLoading}
              >
                {bookingLoading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.bookBtnText}>Book ride</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Booked state */}
        {sheet === 'booked' && (
          <View style={styles.bookedSheet}>
            <Text style={styles.bookedEmoji}>🚖</Text>
            <Text style={styles.bookedTitle}>Ride requested!</Text>
            <Text style={styles.bookedSub}>
              M&G C&J is finding a driver for you.{'\n'}You'll get a notification when one is assigned.
            </Text>
            <TouchableOpacity style={styles.bookedBtn} onPress={resetBooking}>
              <Text style={styles.bookedBtnText}>Back to home</Text>
            </TouchableOpacity>
          </View>
        )}

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
    paddingTop: Platform.OS === 'ios' ? 56 : 40,
    paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: 'rgba(17,24,39,0.85)',
  },
  topGreeting: { flex: 1 },
  topName: { fontSize: 20, fontWeight: '700', color: '#F1F5F9' },
  topSub: { fontSize: 13, color: '#6B7280', marginTop: 1 },
  avatarBtn: { padding: 4 },

  recenterBtn: {
    position: 'absolute',
    right: 16,
    bottom: 340,
    width: 42, height: 42,
    borderRadius: 21,
    backgroundColor: '#1E2A3A',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
    elevation: 4,
  },

  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#111827',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36,
    minHeight: 300,
  },

  inputsCard: {
    backgroundColor: '#1E2A3A',
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 14,
    overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  inputDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  inputDivider: { height: 0.5, backgroundColor: 'rgba(255,255,255,0.07)', marginHorizontal: 16 },
  inputText: { fontSize: 15, color: '#F1F5F9', flex: 1 },
  inputPlaceholder: { color: '#4B5563' },

  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1E2A3A',
    borderRadius: 12,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#F1F5F9' },

  predictionsList: { maxHeight: 220 },
  predictionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 4,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  predictionText: { fontSize: 13, color: '#CBD5E1', flex: 1, lineHeight: 18 },

  sectionLabel: {
    fontSize: 10, fontWeight: '600', color: '#374151',
    letterSpacing: 0.08, marginBottom: 10, marginTop: 4,
  },
  quickRow: { flexDirection: 'row' },
  quickChip: {
    backgroundColor: '#1E2A3A',
    borderRadius: 20,
    paddingVertical: 8, paddingHorizontal: 14,
    marginRight: 8,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
  },
  quickChipText: { fontSize: 13, color: '#CBD5E1' },

  confirmSheet: {},
  confirmTitle: { fontSize: 20, fontWeight: '700', color: '#F1F5F9', marginBottom: 16 },
  routeCard: {
    backgroundColor: '#1E2A3A',
    borderRadius: 14, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 16,
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
    flex: 1, paddingVertical: 14, borderRadius: 12,
    backgroundColor: '#1E2A3A', alignItems: 'center',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  editBtnText: { color: '#9CA3AF', fontSize: 15, fontWeight: '500' },
  bookBtn: {
    flex: 2, paddingVertical: 14, borderRadius: 12,
    backgroundColor: '#E8500A', alignItems: 'center',
  },
  bookBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  bookedSheet: { alignItems: 'center', paddingTop: 10, paddingBottom: 10 },
  bookedEmoji: { fontSize: 48, marginBottom: 14 },
  bookedTitle: { fontSize: 24, fontWeight: '700', color: '#F1F5F9', marginBottom: 10 },
  bookedSub: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  bookedBtn: {
    backgroundColor: '#1E2A3A', borderRadius: 12,
    paddingVertical: 13, paddingHorizontal: 36,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.1)',
  },
  bookedBtnText: { color: '#CBD5E1', fontSize: 15, fontWeight: '500' },
})

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#1d2c3f' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#253d56' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1d3244' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
]
