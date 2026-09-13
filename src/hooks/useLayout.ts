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
