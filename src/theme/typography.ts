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

function withFont(type: unknown, props: any): any {
  if (!props || !isTextType(type)) return props;
  const family = familyForStyle(props.style);
  // fontFamily FIRST so the caller's own style still wins on any conflict
  // (familyForStyle already preserves an explicit fontFamily anyway).
  return { ...props, style: [{ fontFamily: family }, props.style] };
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
