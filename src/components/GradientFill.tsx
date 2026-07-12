import React from "react";
import { StyleProp, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { nativeViewAvailable } from "../lib/nativeViewAvailable";

// Same dev-client caveat as Glass: expo-linear-gradient ships a native view
// (`ExpoLinearGradient`). If the running binary predates the package, rendering
// <LinearGradient> yields a red "Unimplemented component" box. So we detect it
// once and only render the gradient when the native view is registered —
// otherwise we render nothing and let the caller's solid backgroundColor show.
// Rebuilding the dev client flips this to true automatically, no code change.
export const GRADIENT_SUPPORTED: boolean =
  nativeViewAvailable("ExpoLinearGradient");

type Props = {
  colors: readonly [string, string, ...string[]];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: StyleProp<ViewStyle>;
};

/**
 * Drop-in absoluteFill gradient layer. Place behind a control's content; the
 * control keeps a solid `backgroundColor` as the graceful fallback.
 */
export function GradientFill({
  colors,
  start = { x: 0, y: 0 },
  end = { x: 1, y: 1 },
  style,
}: Props) {
  if (!GRADIENT_SUPPORTED) return null;
  return <LinearGradient colors={colors} start={start} end={end} style={style} />;
}
