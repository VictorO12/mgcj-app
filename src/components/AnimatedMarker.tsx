import React, { useEffect, useRef, useState } from "react";
import {
  AnimatedRegion,
  MarkerAnimated,
  type MapMarkerProps,
} from "react-native-maps";

type LatLng = { latitude: number; longitude: number };

type Props = Omit<MapMarkerProps, "coordinate"> & {
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

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Drop-in replacement for react-native-maps <Marker> whose position glides
 * smoothly between coordinate updates instead of teleporting. Wraps
 * MarkerAnimated + AnimatedRegion. Custom children (icon views) are supported.
 */
export default function AnimatedMarker({
  coordinate,
  duration,
  minDuration = 1500,
  maxDuration = 12000,
  snapMeters = null,
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
    const dist = metersBetween(prev, coordinate);
    current.current = coordinate;

    const snap =
      !inited.current ||
      (duration != null && duration <= 0) ||
      (snapMeters != null && dist > snapMeters);
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

    const dur =
      duration != null
        ? duration
        : clamp(now - lastUpdateT.current, minDuration, maxDuration);
    lastUpdateT.current = now;

    const anim = region.timing({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      duration: dur,
      // Coordinate animation is not supported by the native driver.
      useNativeDriver: false,
    } as any);
    anim.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinate.latitude, coordinate.longitude]);

  return (
    <MarkerAnimated
      {...markerProps}
      coordinate={region as any}
      tracksViewChanges={markerProps.tracksViewChanges ?? tracks}
    >
      {children}
    </MarkerAnimated>
  );
}
