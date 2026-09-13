// Centralized typography for the app.
//
// The whole app already styles text with `fontWeight: "500" | "600" | "700" | "800"`
// (plus the implicit "400"/"normal" default). Rather than touch every screen, we
// load a real typeface (Manrope) and monkey-patch RN's default `Text`/`TextInput`
// render so those weights resolve to the matching font file automatically.
//
// To swap the typeface later: install another `@expo-google-fonts/<name>` package,
// change the imports + FONTS map + WEIGHT_TO_FAMILY values below. Nothing else.

import { Text, TextInput, StyleSheet, TextStyle } from "react-native";
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from "@expo-google-fonts/manrope";

// Passed to `useFonts(...)` in App.tsx.
export const FONTS = {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
};

const WEIGHT_TO_FAMILY: Record<string, string> = {
  "100": "Manrope_400Regular",
  "200": "Manrope_400Regular",
  "300": "Manrope_400Regular",
  "400": "Manrope_400Regular",
  normal: "Manrope_400Regular",
  "500": "Manrope_500Medium",
  "600": "Manrope_600SemiBold",
  "700": "Manrope_700Bold",
  bold: "Manrope_700Bold",
  "800": "Manrope_800ExtraBold",
  "900": "Manrope_800ExtraBold",
};

const DEFAULT_FAMILY = "Manrope_400Regular";

function familyForStyle(style: unknown): string {
  const flat = (StyleSheet.flatten(style as TextStyle) || {}) as TextStyle;
  // Respect an explicit fontFamily (e.g. a monospace numeric style) — don't override it.
  if (flat.fontFamily) return flat.fontFamily;
  const weight = flat.fontWeight != null ? String(flat.fontWeight) : "400";
  return WEIGHT_TO_FAMILY[weight] ?? DEFAULT_FAMILY;
}

// On RN 0.81 (Expo SDK 54) `Text`/`TextInput` are defined with the new
// `component()` syntax — they are NOT forwardRef objects and have no `.render`
// to override (the classic global-font trick). Instead we intercept the
// automatic JSX runtime: every `<Text>` / `<TextInput>` in the app is created
// by `jsxDEV` (dev / Expo Go) or `jsx`/`jsxs` (production build). We wrap those
// factory functions so any element whose type is Text/TextInput gets Manrope
// merged into its style, with the weight-appropriate file.

function isTextType(type: unknown): boolean {
  if (type === Text || type === TextInput) return true;
  // Fallback by displayName in case a build wraps the export in a new identity.
  const name = (type as any)?.displayName;
  return name === "Text" || name === "TextInput";
}

/**
 * Ceiling on OS text scaling.
 *
 * RN leaves `allowFontScaling` on with NO upper bound, so a user at an
 * accessibility text size gets 2-3x type poured into rows and pills that were
 * drawn for 1x. We keep scaling on — taxi passengers skew older and large-text
 * users are a real population here, not a hypothetical — but bound it.
 *
 * 1.4 is not arbitrary. iOS's largest *standard* Dynamic Type size (xxxLarge)
 * is 1.35x, and Android's largest standard font scale is 1.30x. So every
 * non-accessibility setting on both platforms passes through completely
 * untouched, and only the accessibility tiers (iOS AX1-AX5, 1.65x-3.12x) clamp
 * — to a size still larger than any standard setting can reach.
 */
export const MAX_FONT_SCALE = 1.4;

function withFont(type: unknown, props: any): any {
  if (!props || !isTextType(type)) return props;
  const family = familyForStyle(props.style);
  return {
    // BEFORE the spread, so an element that passes its own
    // maxFontSizeMultiplier (or allowFontScaling={false}) still wins. Put it
    // after and every local exception silently does nothing — a bug that
    // never announces itself.
    maxFontSizeMultiplier: MAX_FONT_SCALE,
    ...props,
    // fontFamily FIRST so the caller's own style still wins on any conflict
    // (familyForStyle already preserves an explicit fontFamily anyway).
    style: [{ fontFamily: family }, props.style],
  };
}

let patched = false;

/**
 * Make every `Text`/`TextInput` in the app render in Manrope, selecting the
 * weight-appropriate font file from the node's own `fontWeight`. Works by
 * wrapping the JSX runtime factories. Idempotent — call once at startup,
 * before any screen renders.
 */
export function applyFontPatch() {
  if (patched) return;
  patched = true;

  const patchFactory = (mod: any, name: string) => {
    const original = mod?.[name];
    if (typeof original !== "function") return;
    mod[name] = function (type: unknown, props: any, ...rest: any[]) {
      return original.call(this, type, withFont(type, props), ...rest);
    };
  };

  // Dev (Metro/Expo Go) uses jsx-dev-runtime; production bundles use jsx-runtime.
  // Patch whichever is present; both are plain-CJS mutable exports.
  try {
    patchFactory(require("react/jsx-dev-runtime"), "jsxDEV");
  } catch {}
  try {
    const rt = require("react/jsx-runtime");
    patchFactory(rt, "jsx");
    patchFactory(rt, "jsxs");
  } catch {}
}
