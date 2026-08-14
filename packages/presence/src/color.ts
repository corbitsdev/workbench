// Deterministic per-principal color: the same principal always gets the
// same avatar/cursor color, with no server-side storage — the color is a
// pure function of `principalId`, computed identically by every process
// that needs it (route handlers, the browser client's own echo of its own
// state). Hues that would read as the brand's orange accent are nudged
// away so a presence dot is never mistaken for a chrome affordance.
const ACCENT_HUE = 28;
const ACCENT_GUARD_DEGREES = 20;
const SATURATION_PERCENT = 65;
const LIGHTNESS_PERCENT = 45;

function hashToHue(principalId: string): number {
  let hash = 0;
  for (let index = 0; index < principalId.length; index += 1) {
    hash = (hash * 31 + principalId.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

export function colorForPrincipal(principalId: string): string {
  const hue = hashToHue(principalId);
  const adjustedHue =
    hueDistance(hue, ACCENT_HUE) < ACCENT_GUARD_DEGREES
      ? (hue + 180) % 360
      : hue;
  return `hsl(${adjustedHue} ${SATURATION_PERCENT}% ${LIGHTNESS_PERCENT}%)`;
}
