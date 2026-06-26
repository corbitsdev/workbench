export type DeltaDirection = "up" | "down" | "flat";

export type DeltaResult = {
  direction: DeltaDirection;
  /** Percent change vs the previous window, or null when it cannot be computed. */
  pct: number | null;
  delta: number;
  /**
   * False when there is no previous window to compare against. Distinguishes
   * "no change" (comparable, delta 0) from "no comparison available" so the UI
   * does not render a flat indicator that reads as stability.
   */
  comparable: boolean;
};

/**
 * Period-over-period change. `comparable` is false when there is no previous
 * window. `pct` is null when the previous value is absent or zero (no
 * meaningful baseline to divide by); callers render the absolute delta in that
 * case rather than a misleading "∞%".
 */
export function computeDelta(
  current: number,
  previous: number | null | undefined,
): DeltaResult {
  if (previous === null || previous === undefined) {
    return { direction: "flat", pct: null, delta: 0, comparable: false };
  }
  const delta = current - previous;
  const direction: DeltaDirection =
    delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  if (previous === 0) {
    return { direction, pct: null, delta, comparable: true };
  }
  return { direction, pct: (delta / previous) * 100, delta, comparable: true };
}

export type DailyLike = {
  date: string;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Expands a sparse daily series (only days with activity) into a continuous,
 * zero-filled spine from `startDate` to `endDate` inclusive (UTC). Without this
 * a sparkline plots gapped days at equal spacing, drawing a false slope across
 * dates where nothing happened. Returns the input unchanged for an inverted
 * range, and caps at 400 days as a runaway guard.
 */
export function fillDailySeries(
  series: DailyLike[],
  startDate: string,
  endDate: string,
): DailyLike[] {
  const byDate = new Map(series.map((row) => [row.date, row]));
  const msPerDay = 86_400_000;
  let cursor = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(cursor) || Number.isNaN(end) || end < cursor) {
    return series;
  }
  const out: DailyLike[] = [];
  let guard = 0;
  while (cursor <= end && guard < 400) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    out.push(
      byDate.get(date) ?? {
        date,
        turnCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    );
    cursor += msPerDay;
    guard += 1;
  }
  return out;
}

export function cacheHitRate(input: number, cacheRead: number): number {
  const denom = input + cacheRead;
  if (denom <= 0) return 0;
  return (cacheRead / denom) * 100;
}

export function ratePct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

export type SparklineGeometry = {
  points: string;
  coords: { x: number; y: number }[];
};

/**
 * Maps a value series to polyline coordinates in an SVG viewBox of `width` x
 * `height`. The minimum value sits on the bottom edge, the maximum on the top;
 * a flat series renders along the vertical centre.
 */
export function buildSparkline(
  values: number[],
  width: number,
  height: number,
): SparklineGeometry {
  if (values.length === 0) {
    return { points: "", coords: [] };
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;

  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * stepX : width / 2;
    const y =
      span === 0 ? height / 2 : height - ((value - min) / span) * height;
    return { x, y };
  });

  const points = coords.map((c) => `${round(c.x)},${round(c.y)}`).join(" ");
  return { points, coords };
}

export type MosaicSegment = {
  label: string;
  value: number;
  /** Width as a percentage of the total, 0 when the total is 0. */
  pct: number;
};

export function buildMosaic(
  parts: { label: string; value: number }[],
): MosaicSegment[] {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return parts.map((p) => ({
    label: p.label,
    value: p.value,
    pct: total <= 0 ? 0 : (p.value / total) * 100,
  }));
}

export function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${round(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1_000) return `${round(n / 1_000)}k`;
  return `${n}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
