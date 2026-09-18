// Single source of truth for "does this company serve this point" on the
// server — same discipline as _shared/fare.ts and _shared/presence.ts.
//
// Design: .claude/notes/service-areas-plan.md
//
// The containment logic itself is NOT here. It lives in the SQL function
// company_serves_point(), and this module is a typed caller for it. That split
// is deliberate: the `rides` BEFORE INSERT trigger has to run the same check,
// and a trigger cannot call TypeScript. One implementation, three entry points
// — trigger, edge function, and the clients pre-checking an address — rather
// than a JS copy that agrees with the SQL copy right up until someone edits
// one of them. That is why the SQL function is SECURITY DEFINER and granted to
// `authenticated`: an INVOKER function reads through RLS and so answers
// "served" for any session that cannot see the company's rows, which is
// precisely the set of inserts worth checking.
//
// FOUR DOORS reach a ride's coordinates, and every one of them needs a check:
//   1-3. The three client inserts (passenger card, passenger cash, dispatch)
//        — covered by the trigger, which is the only thing that sees all three.
//     4. edit-ride's `relocate` — book a legal ride, then move the dropoff to
//        Montreal. INSERT-only guards miss it entirely, and because edit-ride
//        runs service-role (which the guards exempt, correctly) it must call
//        this module itself. Exactly the vehicle-class surcharge trap: a new
//        server path that forgets the new input silently reverts the fix with
//        nothing failing loudly.
//
// ORDERING: create-payment-intent must check BEFORE it talks to Stripe. It runs
// before the ride row exists, so a trigger-only design takes the hold, then the
// insert is refused, and the passenger is left with a ~7-day authorization for
// a ride that does not exist.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type TripEnd = 'pickup' | 'dropoff'

export interface LatLng { lat: number; lng: number }

/** Human-facing copy for a refusal. Deliberately names the company rather than
 *  saying "out of service area": the passenger is being told something about a
 *  business, not shown a validation error. */
export function outOfAreaMessage(companyName: string | null, end: TripEnd): string {
  const who = companyName ?? 'This company'
  return end === 'pickup'
    ? `${who} doesn't pick up in this area yet.`
    : `${who} doesn't drop off in this area yet.`
}

/**
 * Does `companyId` serve `point` for this end of the trip?
 *
 * Returns TRUE when the company has no active areas at all (serves everywhere)
 * and when companyId is NULL (no company, nothing to test against). Both of
 * those are load-bearing rollout defaults, not oversights — see the SQL
 * function's comment. A default-deny would refuse every booking on the platform
 * the day this ships, before anyone has drawn anything.
 */
export async function servesPoint(
  supabase: SupabaseClient,
  companyId: string | null,
  point: LatLng,
  end: TripEnd,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('company_serves_point', {
    p_company_id: companyId,
    p_lat: point.lat,
    p_lng: point.lng,
    p_mode: end,
  })

  if (error) {
    // Fail OPEN, and say so loudly. A transient PostgREST error must not turn
    // into a wall of refused bookings; the inverse (fail closed) takes the
    // whole platform down on one bad query.
    //
    // For the pre-Stripe check in create-payment-intent this is genuinely safe:
    // the `rides` trigger runs the same DEFINER function at insert and refuses
    // there instead, so the worst case is a hold taken microseconds before a
    // refusal — the ordering problem this module exists to avoid, but only on
    // the rare error path rather than always. For edit-ride there is no trigger
    // behind it, so a failure here means the relocate is allowed; that is the
    // deliberate choice, since refusing a mid-ride destination change on a
    // transient error strands a passenger in a moving car.
    console.error('[serviceArea] company_serves_point failed, allowing:', error)
    return true
  }
  return data === true
}

/**
 * Both ends in one call, for the paths that are about to price or re-price a
 * ride. Returns the offending end, or null when the trip is fine.
 */
export async function checkTrip(
  supabase: SupabaseClient,
  companyId: string | null,
  pickup: LatLng | null,
  dropoff: LatLng | null,
): Promise<TripEnd | null> {
  if (pickup && !(await servesPoint(supabase, companyId, pickup, 'pickup'))) {
    return 'pickup'
  }
  if (dropoff && !(await servesPoint(supabase, companyId, dropoff, 'dropoff'))) {
    return 'dropoff'
  }
  return null
}

/** Service-role client, for callers that don't already hold one. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}
