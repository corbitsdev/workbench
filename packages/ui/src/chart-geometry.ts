/**
 * Pure geometry for the tokenized SVG chart primitives. Kept separate from the
 * React components so the coordinate math is unit-tested in isolation.
 */

export interface ChartPoint {
  x: number;
  y: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Maps a value series to coordinates inside a `width` x `height` viewBox with a
 * zero baseline: value 0 sits on the bottom edge, `max` on the top. Unlike a
 * min/max sparkline this never lifts the floor off zero, so a bar/area reads as
 * "how much" rather than "relative to the smallest day". `max` defaults to the
 * series maximum (never below zero); an all-zero series pins to the bottom.
 * A single point is centered horizontally.
 */
export function seriesToCoords(
  values: number[],
  width: number,
  height: number,
  max?: number,
): ChartPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const top = max ?? Math.max(0, ...values);
  const stepX = n > 1 ? width / (n - 1) : 0;
  return values.map((value, index) => ({
    x: round(n > 1 ? index * stepX : width / 2),
    y: round(top <= 0 ? height : height - (Math.max(0, value) / top) * height),
  }));
}

/** SVG path `d` for a polyline through `coords` (empty string for no points). */
export function buildLinePath(coords: ChartPoint[]): string {
  if (coords.length === 0) return "";
  return coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x} ${c.y}`).join(" ");
}

/**
 * SVG path `d` for a filled area under the line: the line, then down to the
 * baseline and back to the first x, closed. Empty string for no points.
 */
export function buildAreaPath(coords: ChartPoint[], height: number): string {
  if (coords.length === 0) return "";
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  return `${buildLinePath(coords)} L${last.x} ${height} L${first.x} ${height} Z`;
}

/**
 * Rounds `value` up to a "nice" axis maximum (1, 2, 2.5, or 5 times a power of
 * ten) so the top gridline is a readable round number. Non-positive input
 * returns 1 so a chart always has a usable scale.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const fraction = value / magnitude;
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * magnitude;
}
