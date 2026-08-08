import React from "react";
import { View } from "react-native";
import Svg, {
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

// The artwork is drawn nose-up (pointing north) inside this viewBox, so a
// marker `rotation` of N degrees — clockwise from north, which is how
// react-native-maps defines it — maps 1:1 onto the driver's GPS course.
const VB_W = 48;
const VB_H = 84;

// Body: widest at the doors, tapering slightly at both ends.
const BODY =
  "M24,7 C29.5,7 34,9.5 36.2,15 C37.6,18.6 38.5,24 38.8,31 " +
  "C39.1,39 39.1,49 38.8,57 C38.5,64 37.6,69.6 36.2,73 " +
  "C34.4,77.2 29.5,79 24,79 C18.5,79 13.6,77.2 11.8,73 " +
  "C10.4,69.6 9.5,64 9.2,57 C8.9,49 8.9,39 9.2,31 " +
  "C9.5,24 10.4,18.6 11.8,15 C14,9.5 18.5,7 24,7 Z";
// The greenhouse is drawn as one dark glass shape with a body-coloured roof
// panel laid on top — that leaves a windshield, a rear window and two thin
// side-window strips without four separate paths to keep aligned.
const CABIN =
  "M13.4,30 C15.4,24.6 18.6,22.2 24,22.2 C29.4,22.2 32.6,24.6 34.6,30 " +
  "C35.6,38 35.6,50 34.6,58 C32.8,63.2 29.4,65.4 24,65.4 " +
  "C18.6,65.4 15.2,63.2 13.4,58 C12.4,50 12.4,38 13.4,30 Z";
const ROOF =
  "M15.6,34.4 C17.2,32.2 20,31.2 24,31.2 C28,31.2 30.8,32.2 32.4,34.4 " +
  "C33,40.6 33,47.4 32.4,53.6 C30.8,55.8 28,56.8 24,56.8 " +
  "C20,56.8 17.2,55.8 15.6,53.6 C15,47.4 15,40.6 15.6,34.4 Z";

const TYRE = "#141922";

/** Multiply a #rrggbb hex toward black (amount < 1) or white (amount > 1). */
function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(amount <= 1 ? c * amount : 255 - (255 - c) / amount),
      ),
    ),
  );
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

let uid = 0;

type Props = {
  /** Rendered height in px. Width follows the 48:84 aspect. */
  size?: number;
  /** Main body colour. Must be #rrggbb — the shading gradient is derived from it. */
  body: string;
  /** Window glass fill. */
  glass: string;
  /** Hairline outline — what separates the car from the map underneath. */
  stroke: string;
  opacity?: number;
};

/**
 * Top-down vehicle icon for map markers. Replaces the platform 🚗 emoji, which
 * rendered differently on every OS and always faced left.
 *
 * Deliberately plate-less: contrast against the map comes from the contact
 * shadow and the hairline stroke, not from a disc behind it. Direction is
 * readable at 30px from the warm headlights at the nose and red tail lights.
 *
 * NOTE for callers: <AnimatedMarker> freezes its child to a bitmap ~800ms after
 * mount (tracksViewChanges), so these colours are effectively fixed at mount.
 * Pick the role colour up front; don't animate it.
 */
export default function CarMarker({
  size = 34,
  body,
  glass,
  stroke,
  opacity = 1,
}: Props) {
  const width = (size * VB_W) / VB_H;
  // Gradient ids must be unique per instance or several cars on one map share
  // (and fight over) the same def.
  const id = React.useRef(`car${uid++}`).current;
  const dark = shade(body, 0.7);
  const light = shade(body, 1.18);

  return (
    // Explicit dimensions are load-bearing: Android measures marker children to
    // zero without them, and the marker disappears.
    <View style={{ width, height: size }} pointerEvents="none">
      <Svg width={width} height={size} viewBox={`0 0 ${VB_W} ${VB_H}`}>
        <Defs>
          {/* Side-lit gradients — the car reads as a rounded shell rather than
              a flat cutout. */}
          <LinearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={light} />
            <Stop offset="0.42" stopColor={body} />
            <Stop offset="1" stopColor={dark} />
          </LinearGradient>
          <LinearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={shade(body, 1.3)} />
            <Stop offset="0.5" stopColor={body} />
            <Stop offset="1" stopColor={shade(body, 0.82)} />
          </LinearGradient>
        </Defs>

        <G opacity={opacity}>
          {/* Contact shadow, kept inside the silhouette so it grounds the car
              instead of haloing it. SVG blur filters are unreliable across
              react-native-svg platforms, so this is a plain soft ellipse. */}
          <Ellipse cx="24" cy="45" rx="15" ry="30" fill="#000" opacity={0.1} />

          {/* Tyres sit under the body; only a sliver shows at each corner. */}
          <G fill={TYRE}>
            <Rect x="6.9" y="18.5" width="4.8" height="11" rx="2.2" />
            <Rect x="36.3" y="18.5" width="4.8" height="11" rx="2.2" />
            <Rect x="6.9" y="54.5" width="4.8" height="11" rx="2.2" />
            <Rect x="36.3" y="54.5" width="4.8" height="11" rx="2.2" />
          </G>

          <Path
            d={BODY}
            fill={`url(#${id}b)`}
            stroke={stroke}
            strokeWidth={0.9}
            strokeLinejoin="round"
          />

          <Path d={CABIN} fill={glass} />
          <Path d={ROOF} fill={`url(#${id}r)`} />

          <G fill="#FFF6DF">
            <Rect x="12.6" y="11.4" width="7.4" height="3.6" rx="1.8" />
            <Rect x="28" y="11.4" width="7.4" height="3.6" rx="1.8" />
          </G>
          <G fill="#B4231C" opacity={0.9}>
            <Rect x="12.6" y="71.4" width="7.4" height="3.2" rx="1.6" />
            <Rect x="28" y="71.4" width="7.4" height="3.2" rx="1.6" />
          </G>

          {/* Wing mirrors */}
          <Rect x="6.1" y="36.8" width="4.2" height="3.8" rx="1.9" fill={dark} />
          <Rect x="37.7" y="36.8" width="4.2" height="3.8" rx="1.9" fill={dark} />
        </G>
      </Svg>
    </View>
  );
}
