import { useWindowDimensions } from "react-native";

// The widest a column of *content* is allowed to get. Phone layouts were built
// against ~390-430pt, so past roughly this width a full-bleed column stops
// looking generous and starts looking stretched: 60-character lines, buttons a
// hand-span wide, form fields with the label orphaned from the input.
const CONTENT_MAX_WIDTH = 520;

// iPadOS reports the *window*, not the screen, so this is a statement about how
// much room the layout has right now rather than about the hardware. That is the
// useful question, and it stays correct in Split View.
const TABLET_BREAKPOINT = 700;

export interface Layout {
  width: number;
  height: number;
  isTablet: boolean;
  /** Drop on a content column to keep it readable. Never on a map. */
  contentMaxWidth: number;
}

/**
 * Live layout metrics. Prefer this over a module-scope `Dimensions.get()`:
 * that value is captured once when the JS bundle loads and never updated, so it
 * is wrong after a rotation and wrong for every iPad window size.
 */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    isTablet: width >= TABLET_BREAKPOINT,
    contentMaxWidth: Math.min(width, CONTENT_MAX_WIDTH),
  };
}

/**
 * A side padding that widens instead of letting content stretch.
 *
 * On a phone this returns `pad` unchanged — `contentMaxWidth` collapses to the
 * screen width, so the term goes to zero and phone layout is untouched. On a
 * tablet it grows until the column between the two gutters is `contentMaxWidth`.
 *
 * Prefer this over `maxWidth` + `alignSelf` when the element itself should stay
 * full-bleed (a bottom bar bonded to the screen edge, a surface whose background
 * the design wants edge to edge) and only its contents need bounding.
 */
export function gutterFor(layout: Layout, pad: number): number {
  return Math.max(pad, (layout.width - layout.contentMaxWidth) / 2);
}

/**
 * Safe-area padding, in place of a per-platform guess at the same number.
 *
 * These screens were written with `paddingTop: Platform.OS === "ios" ? 56 : 40`
 * and similar. 56 is not a notch height — it is *some* notch height plus a
 * visual gap, and it is wrong on every device whose notch differs: an iPhone SE
 * (20pt inset) wastes ~26pt of dead space, a Dynamic Island phone (59pt) tucks
 * the header ~3pt UNDER the island, and an Android device with a 48dp status bar
 * clips outright. The OS will tell us the real number; ask it.
 */
import type { EdgeInsets } from "react-native-safe-area-context";

/** Visual gap above a screen header, on top of whatever the status bar takes. */
export const HEADER_GAP = 10;

export function safeTop(insets: EdgeInsets, gap: number = HEADER_GAP): number {
  return insets.top + gap;
}

/**
 * Bottom padding clear of the home indicator / Android nav bar.
 *
 * `floor` is what to fall back to on a device with no bottom inset at all (an
 * iPhone SE, or Android 3-button nav on an older target) — pass the value the
 * screen used for Android, which is exactly the gap the design wanted when
 * nothing was intruding. Edge-to-edge is mandatory on Expo SDK 54, so on Android
 * the nav bar now overlays content and this is load-bearing, not cosmetic.
 */
export function safeBottom(insets: EdgeInsets, gap: number, floor: number): number {
  return Math.max(insets.bottom + gap, floor);
}
