import { seriesToCoords } from "./chart-geometry";

function sparklinePoints(
  values: number[],
  width: number,
  height: number,
): { points: string; coords: { x: number; y: number }[] } {
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
  const points = coords.map((c) => `${c.x},${c.y}`).join(" ");
  return { points, coords };
}

export interface StatSparklineProps {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}

/**
 * Compact trend line for stat tiles. Uses the chart blue token (passive data),
 * not the accent action tone.
 */
export function StatSparkline({
  values,
  label,
  width = 120,
  height = 32,
}: StatSparklineProps) {
  const { points, coords } = sparklinePoints(values, width, height);
  if (coords.length === 0) {
    return (
      <div
        className="text-[11px] text-text-3"
        data-testid="stat-sparkline-empty"
      >
        No data
      </div>
    );
  }
  const last = coords[coords.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="text-blue"
      role="img"
      aria-label={label}
      data-testid="stat-sparkline"
      preserveAspectRatio="none"
    >
      {coords.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={last.x} cy={last.y} r={2} fill="currentColor" />
    </svg>
  );
}

/** Zero-baseline sparkline variant using shared chart geometry. */
export function StatSparklineZeroBaseline({
  values,
  label,
  width = 120,
  height = 32,
}: StatSparklineProps) {
  const coords = seriesToCoords(values, width, height);
  if (coords.length === 0) {
    return (
      <div
        className="text-[11px] text-text-3"
        data-testid="stat-sparkline-empty"
      >
        No data
      </div>
    );
  }
  const points = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const last = coords[coords.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="text-blue"
      role="img"
      aria-label={label}
      data-testid="stat-sparkline"
      preserveAspectRatio="none"
    >
      {coords.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={last.x} cy={last.y} r={2} fill="currentColor" />
    </svg>
  );
}
