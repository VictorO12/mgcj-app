import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import Constants from 'expo-constants'

export interface Driver {
  id: string
  vehicle_make: string | null
  vehicle_model: string | null
  plate_number: string | null
  current_lat: number | null
  current_lng: number | null
  name: string | null
  phone: string | null
}

export interface ActiveRide {
  id: string
  status: string
  pickup_address: string
  pickup_lat: number
  pickup_lng: number
  dropoff_address: string
  dropoff_lat: number
  dropoff_lng: number
  fare_estimate: number | null
  fare_final: number | null
  driver: Driver | null
}

const ACTIVE_STATUSES = ['pending', 'assigned', 'driver_arriving', 'in_progress']
const MAPS_KEY = Constants.expoConfig?.extra?.googleMapsKey

export function useActiveRide(passengerId: string | undefined) {
  const [ride, setRide] = useState<ActiveRide | null>(null)
  const [eta, setEta] = useState<number | null>(null)
  const etaInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Fetch on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!passengerId) return
    fetchActiveRide(passengerId)
  }, [passengerId])

  // ── Realtime: ride status changes ───────────────────────────
  useEffect(() => {
    if (!passengerId) return

    const channel = supabase
      .channel('ride-changes-' + passengerId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'rides',
      }, (payload) => {
        const row = payload.new as any
        if (!row || row.passenger_id !== passengerId) return
        console.log('[Realtime] ride update:', row.status)

        if (ACTIVE_STATUSES.includes(row.status)) {
          fetchActiveRide(passengerId)
        } else {
          // completed or cancelled — clear right away
          setRide(null)
          setEta(null)
        }
      })
      .subscribe((status) => {
        console.log('[Realtime] rides channel:', status)
      })

    return () => { supabase.removeChannel(channel) }
  }, [passengerId])

  // ── Realtime: driver location changes ───────────────────────
  useEffect(() => {
    if (!ride?.driver?.id) return

    const driverId = ride.driver.id
    const channel = supabase
      .channel('driver-location-' + driverId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'drivers',
      }, (payload) => {
        const row = payload.new as any
        if (row.id !== driverId) return
        console.log('[Realtime] driver location:', row.current_lat, row.current_lng)

        setRide(prev => {
          if (!prev || !prev.driver) return prev
          return {
            ...prev,
            driver: {
              ...prev.driver,
              current_lat: row.current_lat,
              current_lng: row.current_lng,
            }
          }
        })
      })
      .subscribe((status) => {
        console.log('[Realtime] driver channel:', status)
      })

    return () => { supabase.removeChannel(channel) }
  }, [ride?.driver?.id])

  // ── Recalculate ETA when driver moves ───────────────────────
  useEffect(() => {
    if (etaInterval.current) clearInterval(etaInterval.current)
    if (!ride?.driver?.current_lat) return

    calculateEta(ride)
    etaInterval.current = setInterval(() => calculateEta(ride), 30000)
    return () => {
      if (etaInterval.current) clearInterval(etaInterval.current)
    }
  }, [ride?.driver?.current_lat, ride?.driver?.current_lng])

  // ── Fetch active ride ───────────────────────────────────────
  async function fetchActiveRide(pid: string) {
    // Only fetch genuinely active rides — never completed or cancelled
    const { data: rides, error } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', pid)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) { console.error('[fetchActiveRide] error:', error); return }
    if (!rides || rides.length === 0) { setRide(null); return }

    const rideRow = rides[0]
    let driver: Driver | null = null

    if (rideRow.driver_id) {
      const { data: driverRow, error: driverError } = await supabase
        .from('drivers')
        .select('id, vehicle_make, vehicle_model, plate_number, current_lat, current_lng')
        .eq('id', rideRow.driver_id)
        .single()

      if (driverError) console.error('[fetchActiveRide] driver error:', driverError)

      if (driverRow) {
        const { data: profileRow, error: profileError } = await supabase
          .from('profiles')
          .select('name, phone')
          .eq('id', rideRow.driver_id)
          .single()

        if (profileError) console.error('[fetchActiveRide] profile error:', profileError)

        driver = {
          id: driverRow.id,
          vehicle_make: driverRow.vehicle_make,
          vehicle_model: driverRow.vehicle_model,
          plate_number: driverRow.plate_number,
          current_lat: driverRow.current_lat,
          current_lng: driverRow.current_lng,
          name: profileRow?.name ?? null,
          phone: profileRow?.phone ?? null,
        }
      }
    }

    const assembled: ActiveRide = {
      id: rideRow.id,
      status: rideRow.status,
      pickup_address: rideRow.pickup_address,
      pickup_lat: rideRow.pickup_lat,
      pickup_lng: rideRow.pickup_lng,
      dropoff_address: rideRow.dropoff_address,
      dropoff_lat: rideRow.dropoff_lat,
      dropoff_lng: rideRow.dropoff_lng,
      fare_estimate: rideRow.fare_estimate,
      fare_final: rideRow.fare_final,
      driver,
    }

    console.log('[fetchActiveRide] assembled ride:', assembled.status, '| driver:', driver?.name, '| driver coords:', driver?.current_lat, driver?.current_lng)
    setRide(assembled)
  }

  // ── ETA calculation ─────────────────────────────────────────
  async function calculateEta(currentRide: ActiveRide) {
    console.log('[ETA] driver coords:', currentRide.driver?.current_lat, currentRide.driver?.current_lng)

    if (!currentRide.driver?.current_lat || !currentRide.driver?.current_lng) {
      console.log('[ETA] skipping - no driver coords')
      return
    }

    const target = currentRide.status === 'in_progress'
      ? { lat: currentRide.dropoff_lat, lng: currentRide.dropoff_lng }
      : { lat: currentRide.pickup_lat, lng: currentRide.pickup_lng }

    console.log('[ETA] target coords:', target)
    console.log('[ETA] MAPS_KEY present:', !!MAPS_KEY)

    try {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${currentRide.driver.current_lat},${currentRide.driver.current_lng}` +
        `&destination=${target.lat},${target.lng}` +
        `&key=${MAPS_KEY}`

      console.log('[ETA] fetching url:', url)
      const res = await fetch(url)
      const json = await res.json()
      console.log('[ETA] response status:', json.status)
      console.log('[ETA] routes count:', json.routes?.length)
      console.log('[ETA] duration:', json.routes?.[0]?.legs?.[0]?.duration)

      const seconds = json.routes?.[0]?.legs?.[0]?.duration?.value
      setEta(seconds ? Math.ceil(seconds / 60) : null)
    } catch (e) {
      console.error('[ETA] fetch error:', e)
    }
  }

  // ── Status label ────────────────────────────────────────────
  function statusLabel(status: string, driverName?: string | null): string {
    const name = driverName?.split(' ')[0] ?? 'Your driver'
    switch (status) {
      case 'pending':         return 'Finding your driver…'
      case 'assigned':        return `${name} is on the way`
      case 'driver_arriving': return `${name} is almost there!`
      case 'in_progress':     return "You're on your way"
      case 'completed':       return 'You have arrived!'
      case 'cancelled':       return 'Ride cancelled'
      default:                return 'Connecting…'
    }
  }

  return { ride, eta, statusLabel }
}
