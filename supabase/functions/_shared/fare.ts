// Shared fare computation — the single source of truth for how much a card
// ride's hold and capture are sized. Used by:
//   • create-payment-intent   (booking-time hold for immediate rides)
//   • scheduled-release        (deferred hold for scheduled rides)
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

export async function computeFareFromCoords(
  pickupLat: number, pickupLng: number,
  dropoffLat: number, dropoffLng: number,
  baseFare: number, ratePerKm: number,
): Promise<number> {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${pickupLat},${pickupLng}` +
    `&destination=${dropoffLat},${dropoffLng}` +
    `&key=${GOOGLE_MAPS_KEY}`
  const res  = await fetch(url)
  const json = await res.json()
  const metres: number = json.routes?.[0]?.legs?.[0]?.distance?.value ?? 0
  return Math.round((baseFare + (metres / 1000) * ratePerKm) * 100) / 100
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
  let baseFare  = DEFAULT_BASE_FARE
  let ratePerKm = DEFAULT_RATE_PER_KM
  if (opts.companyId) {
    const { data: pricing } = await serviceClient
      .from('companies')
      .select('base_fare, rate_per_km')
      .eq('id', opts.companyId)
      .maybeSingle()
    if (pricing?.base_fare  != null) baseFare  = pricing.base_fare
    if (pricing?.rate_per_km != null) ratePerKm = pricing.rate_per_km
  }

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
