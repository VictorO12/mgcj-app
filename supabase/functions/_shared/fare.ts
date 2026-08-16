// Shared fare computation — the single source of truth for how much a card
// ride's hold and capture are sized. Used by:
//   • create-payment-intent   (booking-time hold for immediate rides)
//   • scheduled-release        (deferred hold for scheduled rides)
//   • edit-ride                (re-price after a pickup/dropoff change)
//
// These two paths MUST agree on the fare. When they drifted, a scheduled ride's
// hold was sized off a client-writable column while the immediate path computed
// it server-side — a money bug. Keeping the logic here means there is exactly
// one implementation to trust.
//
// The vehicle-class surcharge lives here for the same reason (added 2026-08-16).
// It used to exist ONLY in the two clients: PassengerHomeScreen quoted the
// passenger `fare * (1 + surcharge/100)` and the dashboard did the same, while
// every server-side computation ignored the class entirely. So a surcharged
// ride was quoted high and held low — the mirror image of the $0.75 ride, and
// invisible because nobody complains about being undercharged. Any new fare
// path must take `vehicleClassId`; a fare computed without it silently reverts
// the fix for whichever caller forgets.

const GOOGLE_MAPS_KEY = Deno.env.get('GOOGLE_MAPS_BACKEND_KEY')!

// Platform pricing defaults, used only when a ride has no company or the
// company has left pricing unset. Mirrors the fallbacks the app uses.
const DEFAULT_BASE_FARE   = 4
const DEFAULT_RATE_PER_KM = 1.8

export interface LatLng { lat: number; lng: number }

/**
 * Driving distance in metres over origin → [waypoints…] → destination, summed
 * across every leg. One Directions request regardless of how many points, which
 * is what makes the mid-ride re-price cheap: a destination change needs the
 * distance ALREADY driven plus the distance still to drive, and asking for both
 * as one route with the driver's current position as a waypoint costs a single
 * basic-tier call. (Directions only leaves the basic tier past 10 waypoints or
 * with optimization, neither of which applies here.)
 */
export async function routeMetres(points: LatLng[]): Promise<number> {
  const legs = await routeLegMetres(points)
  return legs.reduce((sum, m) => sum + m, 0)
}

/** Same call, but per-leg — so a two-leg route yields "driven" and "remaining"
 *  separately without paying for a second request. */
export async function routeLegMetres(points: LatLng[]): Promise<number[]> {
  if (points.length < 2) return []
  const origin      = points[0]
  const destination = points[points.length - 1]
  const waypoints   = points.slice(1, -1)
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${origin.lat},${origin.lng}` +
    `&destination=${destination.lat},${destination.lng}` +
    (waypoints.length
      ? `&waypoints=${waypoints.map(w => `${w.lat},${w.lng}`).join('|')}`
      : '') +
    `&key=${GOOGLE_MAPS_KEY}`
  const res  = await fetch(url)
  const json = await res.json()
  const legs: any[] = json.routes?.[0]?.legs ?? []
  return legs.map(leg => leg?.distance?.value ?? 0)
}

/** The company's pricing formula. The ONLY place distance becomes money.
 *
 *  The vehicle-class surcharge multiplies the WHOLE fare, base included — the
 *  same shape the passenger is quoted in PassengerHomeScreen (`baseFare * (1 +
 *  surcharge/100)`, where its `baseFare` is the already-computed fare). Getting
 *  this wrong in the other direction — applying it to the distance component
 *  only — would quote one number and charge another, which is the whole reason
 *  the surcharge came server-side. */
export function fareFromMetres(
  metres: number, baseFare: number, ratePerKm: number, surchargePercent = 0,
): number {
  const fare = baseFare + (metres / 1000) * ratePerKm
  return Math.round(fare * (1 + surchargePercent / 100) * 100) / 100
}

/**
 * A vehicle class's surcharge percent, or 0 when there is no class.
 *
 * Scoped to the company on purpose: `vehicle_class_id` reaches the server from
 * the client on the immediate-booking path (create-payment-intent runs before
 * the ride row exists), and a class id belonging to some other company must
 * never price a ride here. An unknown or foreign id yields 0 rather than an
 * error — the un-surcharged fare is the safe direction to fail, and it is what
 * every caller did before this existed.
 *
 * Note the surcharge only ever RAISES the fare, so a passenger who sends a
 * cheaper class is not exploiting anything: assign-ride filters drivers by the
 * same `vehicle_class_id` written to the row, so they get the cheaper class of
 * vehicle they paid for.
 */
// deno-lint-ignore no-explicit-any
export async function getVehicleSurcharge(
  serviceClient: any, companyId: string | null, vehicleClassId: string | null | undefined,
): Promise<number> {
  if (!vehicleClassId || !companyId) return 0
  const { data } = await serviceClient
    .from('vehicle_classes')
    .select('surcharge_percent')
    .eq('id', vehicleClassId)
    .eq('company_id', companyId)
    .maybeSingle()
  return data?.surcharge_percent ?? 0
}

/** Company pricing, falling back to the platform defaults. */
// deno-lint-ignore no-explicit-any
export async function getCompanyPricing(
  serviceClient: any, companyId: string | null,
): Promise<{ baseFare: number; ratePerKm: number }> {
  let baseFare  = DEFAULT_BASE_FARE
  let ratePerKm = DEFAULT_RATE_PER_KM
  if (companyId) {
    const { data: pricing } = await serviceClient
      .from('companies')
      .select('base_fare, rate_per_km')
      .eq('id', companyId)
      .maybeSingle()
    if (pricing?.base_fare   != null) baseFare  = pricing.base_fare
    if (pricing?.rate_per_km != null) ratePerKm = pricing.rate_per_km
  }
  return { baseFare, ratePerKm }
}

export async function computeFareFromCoords(
  pickupLat: number, pickupLng: number,
  dropoffLat: number, dropoffLng: number,
  baseFare: number, ratePerKm: number,
  surchargePercent = 0,
): Promise<number> {
  const metres = await routeMetres([
    { lat: pickupLat,  lng: pickupLng  },
    { lat: dropoffLat, lng: dropoffLng },
  ])
  return fareFromMetres(metres, baseFare, ratePerKm, surchargePercent)
}

export interface AuthoritativeFare {
  fare:           number         // pre-discount fare from coords + company pricing
  discountedFare: number         // what to actually hold / capture
  discountAmount: number
  discountType:   string | null
  discountCodeId: string | null
}

// Recompute the authoritative fare + discount for a booking, server-side.
// `serviceClient` must be a service-role Supabase client (bypasses RLS).
// `discountCode` is the raw code string (resolve it from discount_code_id at
// the call site if you only have the id) — the discount RPC re-validates it,
// so an expired/exhausted code simply yields no code discount here.
// deno-lint-ignore no-explicit-any
export async function computeAuthoritativeFare(
  serviceClient: any,
  opts: {
    userId:     string
    companyId:  string | null
    pickupLat:  number; pickupLng:  number
    dropoffLat: number; dropoffLng: number
    discountCode?:   string | null
    vehicleClassId?: string | null
  },
): Promise<AuthoritativeFare> {
  const { baseFare, ratePerKm } = await getCompanyPricing(serviceClient, opts.companyId)
  const surchargePercent = await getVehicleSurcharge(
    serviceClient, opts.companyId, opts.vehicleClassId,
  )

  const fare = await computeFareFromCoords(
    opts.pickupLat, opts.pickupLng, opts.dropoffLat, opts.dropoffLng,
    baseFare, ratePerKm, surchargePercent,
  )

  let discountedFare = fare
  let discountAmount = 0
  let discountType: string | null = null
  let discountCodeId: string | null = null
  if (opts.companyId && fare > 0) {
    const { data: discount } = await serviceClient
      .rpc('compute_discount_for_booking', {
        p_user_id:    opts.userId,
        p_company_id: opts.companyId,
        p_fare:       fare,
        p_code:       opts.discountCode ?? null,
      })
      .maybeSingle()
    if (discount) {
      discountedFare = discount.discounted_fare ?? fare
      discountAmount = discount.discount_amount ?? 0
      discountType   = discount.discount_type ?? null
      discountCodeId = discount.code_id ?? null
    }
  }

  return { fare, discountedFare, discountAmount, discountType, discountCodeId }
}
