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

/** Layout axis for a linear step graph (catalog preview vs run/trace density). */
export type StepGraphLayoutAxis = "horizontal" | "vertical";

export interface StepGraphLayoutOptions {
  count: number;
  /** Inner span along the flow axis before padding. */
  span: number;
  /** Fixed coordinate on the cross axis (center of the connector lane). */
  crossCenter: number;
  /** Half-width or half-height of a node along the flow axis — edges stop here. */
  nodeInset: number;
  axis?: StepGraphLayoutAxis;
}

/**
 * Evenly spaces step node centers along a single lane so run order reads
 * unambiguously left-to-right (or top-to-bottom when vertical).
 */
export function layoutLinearStepCenters(
  options: StepGraphLayoutOptions,
): ChartPoint[] {
  const { count, span, crossCenter, nodeInset, axis = "horizontal" } = options;
  if (count <= 0) return [];
  const inner = Math.max(0, span - nodeInset * 2);
  const step =
    count > 1 ? inner / (count - 1) : 0;
  const along = (index: number) => round(nodeInset + index * step);
  return Array.from({ length: count }, (_, index) =>
    axis === "horizontal"
      ? { x: along(index), y: round(crossCenter) }
      : { x: round(crossCenter), y: along(index) },
  );
}

export interface StepGraphEdgeEndpoints {
  from: ChartPoint;
  to: ChartPoint;
}

/**
 * Anchor points on the node boundary for a connector between two centers.
 */
export function stepGraphEdgeEndpoints(
  fromCenter: ChartPoint,
  toCenter: ChartPoint,
  nodeInset: number,
  axis: StepGraphLayoutAxis = "horizontal",
): StepGraphEdgeEndpoints {
  if (axis === "horizontal") {
    return {
      from: { x: round(fromCenter.x + nodeInset), y: fromCenter.y },
      to: { x: round(toCenter.x - nodeInset), y: toCenter.y },
    };
  }
  return {
    from: { x: fromCenter.x, y: round(fromCenter.y + nodeInset) },
    to: { x: toCenter.x, y: round(toCenter.y - nodeInset) },
  };
}

/** SVG path for one directed edge between two node centers. */
export function buildStepGraphEdgePath(
  fromCenter: ChartPoint,
  toCenter: ChartPoint,
  nodeInset: number,
  axis: StepGraphLayoutAxis = "horizontal",
): string {
  const { from, to } = stepGraphEdgeEndpoints(
    fromCenter,
    toCenter,
    nodeInset,
    axis,
  );
  return buildLinePath([from, to]);
}

/** `{ from, to }` pairs linking each step to its successor in run order. */
export function sequentialStepEdges(
  stepIds: readonly string[],
): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < stepIds.length - 1; i++) {
    edges.push({ from: stepIds[i]!, to: stepIds[i + 1]! });
  }
  return edges;
}
