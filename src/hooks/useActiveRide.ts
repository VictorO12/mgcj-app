import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

export interface Driver {
  id: string
  vehicle_make: string | null
  vehicle_model: string | null
  plate_number: string | null
  current_lat: number | null
  current_lng: number | null
  name: string | null
  phone: string | null
  avatar_url: string | null
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

const ACTIVE_STATUSES = ['pending', 'offered', 'assigned', 'driver_arriving', 'in_progress']

function isRideNow(row: any): boolean {
  if (!row.scheduled_at) return true
  return new Date(row.scheduled_at) <= new Date()
}

export function useActiveRide(passengerId: string | undefined) {
  const [ride, setRide] = useState<ActiveRide | null>(null)
  const [eta, setEta] = useState<number | null>(null)
  // Holds the last known ride so we can surface it briefly on completion
  const lastRideRef = useRef<ActiveRide | null>(null)
  const [cancelledReason, setCancelledReason] = useState<string | null>(null)

  useEffect(() => {
    if (ride) lastRideRef.current = ride
  }, [ride])

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
        filter: 'passenger_id=eq.' + passengerId,
      }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as any)?.id
          console.log('[Realtime] ride deleted:', deletedId)
          setRide(prev => (prev && prev.id === deletedId ? null : prev))
          setEta(null)
          return
        }

        const row = payload.new as any
        if (!row || row.passenger_id !== passengerId) return
        console.log('[Realtime] ride update:', row.status, '| scheduled_at:', row.scheduled_at)

        if (ACTIVE_STATUSES.includes(row.status) && isRideNow(row)) {
          fetchActiveRide(passengerId)
        } else if (row.status === 'completed') {
          // Use lastRideRef to surface the completed state even if ride
          // was already cleared — gives PassengerHomeScreen time to detect
          // status === 'completed' and open the review modal
          const completedRide = lastRideRef.current
            ? { ...lastRideRef.current, status: 'completed' }
            : null
          setRide(completedRide)
          setEta(null)
          // Clear after 3s — plenty of time for the useEffect in
          // PassengerHomeScreen to fire and set reviewTarget
          setTimeout(() => setRide(null), 3000)
        } else {
          // cancelled
          setRide(null)
          setEta(null)
          if (row.cancelled_reason === 'timeout') {
            setCancelledReason('timeout')
          }
        }
      })
      .subscribe((status) => {
        console.log('[Realtime] rides channel:', status)
      })

    return () => { supabase.removeChannel(channel) }
  }, [passengerId])

  // ── Realtime: driver location changes ───────────────────────
  // Also polls directly every 10s as a fallback — realtime UPDATEs on
  // `drivers` are gated by RLS, and if a passenger lacks SELECT access to
  // another user's driver row, postgres_changes silently never delivers
  // even though .subscribe() reports SUBSCRIBED.
  useEffect(() => {
    if (!ride?.driver?.id) return

    const driverId = ride.driver.id

    function applyLocation(lat: number | null, lng: number | null, etaSeconds: number | null) {
      setRide(prev => {
        if (!prev || !prev.driver) return prev
        return {
          ...prev,
          driver: { ...prev.driver, current_lat: lat, current_lng: lng }
        }
      })
      // ETA is computed on the driver's device (traffic-aware route ETA,
      // interpolated locally each GPS tick) and broadcast on the same drivers
      // row — so it arrives with the location, no Google call here. This used to
      // fire a Directions request on every single update: the app's biggest
      // Maps cost by far.
      setEta(etaSeconds != null ? Math.max(1, Math.ceil(etaSeconds / 60)) : null)
    }

    const channel = supabase
      .channel('driver-location-' + driverId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'drivers',
      }, (payload) => {
        const row = payload.new as any
        if (row.id !== driverId) return
        console.log('[Realtime] driver location:', row.current_lat, row.current_lng, '| eta_s:', row.active_ride_eta_seconds)
        applyLocation(row.current_lat, row.current_lng, row.active_ride_eta_seconds ?? null)
      })
      .subscribe((status) => {
        console.log('[Realtime] driver channel:', status)
      })

    const poll = setInterval(async () => {
      const { data } = await supabase
        .from('drivers')
        .select('current_lat, current_lng, active_ride_eta_seconds')
        .eq('id', driverId)
        .maybeSingle()
      if (data) applyLocation(data.current_lat, data.current_lng, data.active_ride_eta_seconds ?? null)
    }, 10000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(poll)
    }
  }, [ride?.driver?.id])

  // ── Clear stale ETA when there's no confirmed driver ─────────
  // While a driver IS assigned, `eta` is set from their broadcast in
  // applyLocation. When there's no confirmed driver (still 'offered', or reset
  // by a decline/reassignment), make sure we never leave a stale ETA on screen.
  useEffect(() => {
    if (!ride?.driver?.id) setEta(null)
  }, [ride?.driver?.id, ride?.status])

  // ── Fetch active ride ───────────────────────────────────────
  async function fetchActiveRide(pid: string) {
    const now = new Date().toISOString()

    const { data: rides, error } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', pid)
      .in('status', ACTIVE_STATUSES)
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) { console.error('[fetchActiveRide] error:', error); return }
    if (!rides || rides.length === 0) { setRide(null); return }

    const rideRow = rides[0]
    let driver: Driver | null = null
    let driverEtaSeconds: number | null = null

    // Don't reveal the candidate driver until they've actually confirmed —
    // 'offered' rides have a driver_id but it's not committed yet.
    if (rideRow.driver_id && rideRow.status !== 'offered') {
      const { data: driverRow, error: driverError } = await supabase
        .from('drivers')
        .select('id, vehicle_make, vehicle_model, plate_number, current_lat, current_lng, active_ride_eta_seconds')
        .eq('id', rideRow.driver_id)
        .single()

      if (driverError) console.error('[fetchActiveRide] driver error:', driverError)

      if (driverRow) {
        const { data: profileRow, error: profileError } = await supabase
          .from('profiles')
          .select('name, phone, avatar_url')
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
          avatar_url: profileRow?.avatar_url ?? null,
        }
        driverEtaSeconds = driverRow.active_ride_eta_seconds ?? null
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

    console.log('[fetchActiveRide] assembled ride:', assembled.status, '| driver:', driver?.name, '| eta_s:', driverEtaSeconds)
    // Seed ETA from the driver's last broadcast; Realtime/poll keeps it fresh.
    setEta(driver && driverEtaSeconds != null ? Math.max(1, Math.ceil(driverEtaSeconds / 60)) : null)
    setRide(assembled)
  }

  // ── Status label ────────────────────────────────────────────
  function statusLabel(status: string, driverName?: string | null): string {
    const name = driverName?.split(' ')[0] ?? 'Your driver'
    switch (status) {
      case 'pending':         return 'Finding your driver…'
      case 'offered':         return 'Finding your driver…'
      case 'assigned':        return `${name} is on the way`
      case 'driver_arriving': return `${name} has arrived!`
      case 'in_progress':     return "You're on your way"
      case 'completed':       return 'You have arrived!'
      case 'cancelled':       return 'Ride cancelled'
      default:                return 'Connecting…'
    }
  }

  return { ride, eta, statusLabel, cancelledReason, clearCancelledReason: () => setCancelledReason(null) }
}