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

/** The company's pricing formula. The ONLY place distance becomes money. */
export function fareFromMetres(metres: number, baseFare: number, ratePerKm: number): number {
  return Math.round((baseFare + (metres / 1000) * ratePerKm) * 100) / 100
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
): Promise<number> {
  const metres = await routeMetres([
    { lat: pickupLat,  lng: pickupLng  },
    { lat: dropoffLat, lng: dropoffLng },
  ])
  return fareFromMetres(metres, baseFare, ratePerKm)
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
    discountCode?: string | null
  },
): Promise<AuthoritativeFare> {
  const { baseFare, ratePerKm } = await getCompanyPricing(serviceClient, opts.companyId)

  const fare = await computeFareFromCoords(
    opts.pickupLat, opts.pickupLng, opts.dropoffLat, opts.dropoffLng,
    baseFare, ratePerKm,
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
