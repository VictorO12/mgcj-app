// Where the map opens before we know where the passenger/driver is.
//
// Design: .claude/notes/service-areas-plan.md §2
//
// Both home screens used to hardcode the same Annapolis Valley region. That was
// invisible while every user was in the Valley and becomes absurd the moment a
// company anywhere else installs the app — the map opens a province away and
// stays there until the GPS fix lands.
//
// The company's own service areas answer it properly: their bounding box gives
// position and extent together, so there is no zoom constant to pick either.
// Order is areas -> the company's city, asked once at onboarding. There used to
// be a third rung, a hardcoded Kentville; it is deleted. A Nova Scotia
// coordinate is not a default for a company in Moncton, and while it existed as
// the floor there was never any pressure for a right answer to exist.
//
// The city carries its Places VIEWPORT, so a city frames as that city rather
// than as a point plus a guessed span — the same reason drawn areas are better.
//
// NOTE the app's ordering differs from the dashboard's: here a real GPS fix
// still wins over the company frame. The company frame is what fills the gap
// before the fix arrives, or when location permission is denied. The dashboard
// has no GPS at all, which is why this matters more over there.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

// What the map paints on the very first frame, before anything resolves.
// Deliberately a wide continental view and not a place: a map of the WRONG town
// reads as a bug, a zoomed-out one reads as loading. After the first launch the
// cache below means this is almost never seen.
export const NEUTRAL_REGION: Region = {
  latitude: 45.0,
  longitude: -75.0,
  latitudeDelta: 30,
  longitudeDelta: 30,
};

// Only for a city row that somehow has a centre but no viewport. A point cannot
// express extent, so the span has to be guessed — which is what storing the
// viewport exists to avoid.
const CITY_FALLBACK_DELTA = 0.2;

const CACHE_KEY = "companyRegion.v1";

// The company's frame changes about never, and the map needs an answer on frame
// one. Reading it from disk is milliseconds where the query is a round trip, so
// every launch after the first opens correctly instead of animating in.
export async function readCachedRegion(companyId: string): Promise<Region | null> {
  try {
    const raw = await AsyncStorage.getItem(`${CACHE_KEY}:${companyId}`);
    return raw ? (JSON.parse(raw) as Region) : null;
  } catch {
    return null;
  }
}

async function cacheRegion(companyId: string, region: Region) {
  try {
    await AsyncStorage.setItem(`${CACHE_KEY}:${companyId}`, JSON.stringify(region));
  } catch {
    // A cache that fails to write costs one animated reframe next launch.
  }
}

// A bounding box fitted exactly to the polygon puts the boundary on the screen
// edge. A little air makes it read as an area rather than a crop.
const BBOX_PADDING = 1.25;
const MIN_DELTA = 0.02;

interface AreaRow {
  area_geojson: { coordinates: number[][][][] } | null;
}

/** Resolves to the region this company's map should open on, or null if the
 *  lookup failed — callers keep whatever they were showing in that case. */
export async function fetchCompanyRegion(
  companyId: string | null | undefined,
): Promise<Region | null> {
  if (!companyId) return null;

  const [areasRes, companyRes] = await Promise.all([
    supabase
      .from("service_areas_geo")
      .select("area_geojson")
      .eq("company_id", companyId)
      .eq("active", true),
    supabase
      .from("companies")
      // One literal string: supabase-js parses this at the type level, and a
      // concatenated expression infers as GenericStringError.
      .select("service_city_lat, service_city_lng, service_city_north, service_city_south, service_city_east, service_city_west")
      .eq("id", companyId)
      .maybeSingle(),
  ]);

  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  let any = false;
  for (const a of (areasRes.data ?? []) as AreaRow[]) {
    for (const polygon of a.area_geojson?.coordinates ?? []) {
      for (const ring of polygon) {
        for (const [lng, lat] of ring) {
          north = Math.max(north, lat); south = Math.min(south, lat);
          east = Math.max(east, lng);  west = Math.min(west, lng);
          any = true;
        }
      }
    }
  }

  if (any) {
    const region: Region = {
      latitude: (north + south) / 2,
      longitude: (east + west) / 2,
      latitudeDelta: Math.max((north - south) * BBOX_PADDING, MIN_DELTA),
      longitudeDelta: Math.max((east - west) * BBOX_PADDING, MIN_DELTA),
    };
    cacheRegion(companyId, region);
    return region;
  }

  const c = companyRes.data;
  if (c?.service_city_lat != null && c?.service_city_lng != null) {
    const hasViewport =
      c.service_city_north != null && c.service_city_south != null &&
      c.service_city_east != null && c.service_city_west != null;
    const region: Region = hasViewport
      ? {
          latitude: (c.service_city_north! + c.service_city_south!) / 2,
          longitude: (c.service_city_east! + c.service_city_west!) / 2,
          latitudeDelta: Math.max(c.service_city_north! - c.service_city_south!, MIN_DELTA),
          longitudeDelta: Math.max(c.service_city_east! - c.service_city_west!, MIN_DELTA),
        }
      : {
          latitude: c.service_city_lat,
          longitude: c.service_city_lng,
          latitudeDelta: CITY_FALLBACK_DELTA,
          longitudeDelta: CITY_FALLBACK_DELTA,
        };
    cacheRegion(companyId, region);
    return region;
  }

  return null;
}
