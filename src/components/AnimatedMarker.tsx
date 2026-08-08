import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import {
  AnimatedRegion,
  MarkerAnimated,
  type MapMarkerProps,
} from "react-native-maps";

type LatLng = { latitude: number; longitude: number };

type Props = Omit<MapMarkerProps, "coordinate" | "rotation"> & {
  coordinate: LatLng;
  /**
   * Fixed glide duration (ms). If omitted, the glide is *adaptive*: it lasts
   * the measured interval since the previous update, clamped to
   * [minDuration, maxDuration]. Adaptive is right for remote feeds (passenger /
   * dispatch) whose cadence varies (~5s active, ~10s idle); a fixed short
   * duration is right for a device's own GPS (steady ~1s).
   */
  duration?: number;
  minDuration?: number;
  maxDuration?: number;
  /**
   * Snap instantly (no glide) when a new coordinate is farther than this many
   * meters from the current one — a teleport / GPS spike / reroute, not real
   * driving. Pass null to always glide. Keep small for own-GPS (precise, no
   * trail), large for remote feeds (so real highway movement still glides).
   */
  snapMeters?: number | null;
  /**
   * Travel direction in degrees clockwise from north. Pass the driver's real
   * GPS course (`drivers.heading`) when it's known; pass null/undefined and the
   * bearing is derived from consecutive coordinates instead — which is what
   * keeps drivers on older app builds (heading still NULL) pointing correctly.
   */
  heading?: number | null;
};

// Equirectangular approximation — plenty accurate for a threshold check.
function metersBetween(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/** Initial great-circle bearing a → b, degrees clockwise from north. */
function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(a.latitude);
  const p2 = toRad(b.latitude);
  const dl = toRad(b.longitude - a.longitude);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// Below this much movement between fixes, a derived bearing is just GPS noise —
// a parked car would spin at random. Hold the last known direction instead.
const MIN_BEARING_METERS = 12;

// Turn duration used when only the heading changed (car pivoting in place, or a
// fresh course arriving between position updates).
const HEADING_ONLY_TURN_MS = 700;

/**
 * Drop-in replacement for react-native-maps <Marker> whose position glides
 * smoothly between coordinate updates instead of teleporting, and which rotates
 * to face its direction of travel. Wraps MarkerAnimated + AnimatedRegion.
 * Custom children (icon views) are supported.
 *
 * Rotation goes through the marker's *native* `rotation` prop, never a
 * transform on the child view: `tracksViewChanges` is switched off shortly
 * after mount (see below), which rasterizes the child to a bitmap on Android —
 * a child transform would animate for about a second and then freeze.
 */
export default function AnimatedMarker({
  coordinate,
  duration,
  minDuration = 1500,
  maxDuration = 12000,
  snapMeters = null,
  heading,
  children,
  ...markerProps
}: Props) {
  const region = useRef(
    new AnimatedRegion({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  ).current;

  const current = useRef<LatLng>(coordinate);
  const lastUpdateT = useRef<number>(Date.now());
  const inited = useRef(false);

  // Rotation is kept *unwrapped* (it can drift past 360° or below 0°) so that
  // every turn takes the short way round: 355° → 5° must animate +10°, not
  // −350°. Only the delta is normalised.
  const rotation = useRef(new Animated.Value(0)).current;
  const displayedDeg = useRef(0);
  const bearing = useRef(0);
  const rotationAnim = useRef<Animated.CompositeAnimation | null>(null);
  const positionAnim = useRef<Animated.CompositeAnimation | null>(null);

  function turnTo(target: number, dur: number) {
    const delta = ((((target - displayedDeg.current) % 360) + 540) % 360) - 180;
    if (Math.abs(delta) < 0.5 && inited.current) return;
    displayedDeg.current += delta;
    rotationAnim.current?.stop();
    if (dur <= 0) {
      rotation.setValue(displayedDeg.current);
      return;
    }
    rotationAnim.current = Animated.timing(rotation, {
      toValue: displayedDeg.current,
      duration: dur,
      easing: Easing.out(Easing.quad),
      // Marker rotation is a native view prop, not a style — no native driver.
      useNativeDriver: false,
    });
    rotationAnim.current.start();
  }

  // tracksViewChanges must be false during the glide or the marker view
  // re-rasterizes every frame (flicker/lag on iOS). Keep it true only long
  // enough for the custom child to paint once.
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracks(false), 800);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const prev = current.current;
    const moved = metersBetween(prev, coordinate);
    const samePoint =
      prev.latitude === coordinate.latitude &&
      prev.longitude === coordinate.longitude;
    current.current = coordinate;

    const snap =
      !inited.current ||
      (duration != null && duration <= 0) ||
      (snapMeters != null && moved > snapMeters);

    const dur =
      duration != null
        ? duration
        : clamp(now - lastUpdateT.current, minDuration, maxDuration);

    // ── Direction ──────────────────────────────────────────────────────────
    // Explicit GPS course wins. Otherwise derive it from the step just taken,
    // but only if the step was long enough to mean something, and never off a
    // snap (a teleport / first fix / reroute has no direction).
    let target = bearing.current;
    if (typeof heading === "number" && Number.isFinite(heading)) {
      target = ((heading % 360) + 360) % 360;
    } else if (!snap && moved > MIN_BEARING_METERS) {
      target = bearingBetween(prev, coordinate);
    }
    const headingOnly = samePoint && !snap;
    if (target !== bearing.current || !inited.current) {
      bearing.current = target;
      turnTo(target, snap ? 0 : headingOnly ? HEADING_ONLY_TURN_MS : dur);
    }

    // ── Position ───────────────────────────────────────────────────────────
    inited.current = true;

    if (snap) {
      region.setValue({
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        latitudeDelta: 0,
        longitudeDelta: 0,
      } as any);
      lastUpdateT.current = now;
      return;
    }
    if (samePoint) return;

    lastUpdateT.current = now;

    positionAnim.current?.stop();
    positionAnim.current = region.timing({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      duration: dur,
      // Coordinate animation is not supported by the native driver.
      useNativeDriver: false,
    } as any);
    positionAnim.current.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinate.latitude, coordinate.longitude, heading]);

  // Stop both animations on unmount. A glide can still be running up to
  // maxDuration (12s) after a driver goes offline and the marker is removed;
  // an in-flight AnimatedRegion timing keeps driving the detached native view,
  // which can leave a ghost car on the map until the map itself remounts.
  useEffect(
    () => () => {
      rotationAnim.current?.stop();
      positionAnim.current?.stop();
    },
    [],
  );

  return (
    <MarkerAnimated
      // Rotate in map space, so the car turns with the road rather than with
      // the screen when the camera is bearing-locked (driver nav mode).
      flat={markerProps.flat ?? true}
      {...markerProps}
      coordinate={region as any}
      rotation={rotation as any}
      tracksViewChanges={markerProps.tracksViewChanges ?? tracks}
    >
      {children}
    </MarkerAnimated>
  );
}
