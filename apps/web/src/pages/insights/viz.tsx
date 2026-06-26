import {
  buildMosaic,
  buildSparkline,
  formatCompact,
  type DeltaResult,
} from "./metrics";

// Theme-adaptive categorical ramp: accent family + neutral text layers. Every
// token is overridden per theme, so the mosaic stays coherent on the green
// (tkww) and monochrome (notion) themes — unlike fixed blue/green, which are
// defined only on :root and would clash there.
const MOSAIC_TONES = [
  "fill-accent",
  "fill-accent-deep",
  "fill-accent-soft",
  "fill-text-3",
  "fill-text-2",
] as const;

export function Sparkline({
  values,
  label,
  width = 120,
  height = 32,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  const { points, coords } = buildSparkline(values, width, height);
  if (coords.length === 0) {
    return (
      <div className="text-[11px] text-text-3" data-testid="sparkline-empty">
        No data
      </div>
    );
  }
  const last = coords[coords.length - 1];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="text-accent"
      role="img"
      aria-label={label}
      data-testid="sparkline"
      data-point-count={coords.length}
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

export type HeatmapDay = { date: string; value: number };

export function Heatmap({
  days,
  label,
}: {
  days: HeatmapDay[];
  label: string;
}) {
  const max = days.reduce((m, d) => Math.max(m, d.value), 0);
  const activeDays = days.filter((d) => d.value > 0).length;
  return (
    <div
      className="flex flex-wrap gap-[3px]"
      role="img"
      aria-label={`${label}: ${activeDays} active days, peak ${max}`}
      data-testid="heatmap"
    >
      {days.map((day) => {
        const intensity = max <= 0 ? 0 : day.value / max;
        const empty = day.value === 0;
        return (
          <span
            key={day.date}
            data-testid="heatmap-cell"
            data-date={day.date}
            data-value={day.value}
            title={`${day.date}: ${day.value}`}
            className={`h-3 w-3 rounded-[2px] border border-border ${empty ? "bg-surface-2" : "bg-accent"}`}
            style={empty ? undefined : { opacity: 0.4 + intensity * 0.6 }}
          />
        );
      })}
    </div>
  );
}

export function TokenMosaic({
  parts,
  label,
}: {
  parts: { label: string; value: number }[];
  label: string;
}) {
  const segments = buildMosaic(parts);
  return (
    <div className="flex flex-col gap-2" data-testid="token-mosaic">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-[3px] bg-surface-2"
        role="img"
        aria-label={label}
      >
        <svg
          className="h-full w-full"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
        >
          {renderMosaicRects(segments)}
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((seg, i) => (
          <span
            key={seg.label}
            data-testid="mosaic-legend"
            data-pct={seg.pct.toFixed(2)}
            className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-text-3"
          >
            <span
              className={`h-2 w-2 rounded-[1px] ${toneToBg(MOSAIC_TONES[i % MOSAIC_TONES.length])}`}
            />
            {seg.label} {formatCompact(seg.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

function renderMosaicRects(
  segments: { label: string; value: number; pct: number }[],
) {
  let x = 0;
  return segments.map((seg, i) => {
    const rect = (
      <rect
        key={seg.label}
        x={x}
        y={0}
        width={seg.pct}
        height={10}
        className={MOSAIC_TONES[i % MOSAIC_TONES.length]}
        data-testid="mosaic-rect"
        data-label={seg.label}
      />
    );
    x += seg.pct;
    return rect;
  });
}

function toneToBg(fillClass: string): string {
  return fillClass.replace("fill-", "bg-");
}

export function DeltaBadge({ delta }: { delta: DeltaResult }) {
  if (!delta.comparable) {
    return null;
  }
  if (delta.direction === "flat") {
    return (
      <span
        className="font-mono text-[11px] tabular-nums tracking-[0.04em] text-text-3"
        data-testid="delta-badge"
        data-direction="flat"
        aria-label="no change vs previous period"
      >
        0%
      </span>
    );
  }
  const up = delta.direction === "up";
  const arrow = up ? "▲" : "▼";
  const tone = up ? "text-accent-deep" : "text-text-2";
  const text =
    delta.pct !== null
      ? `${Math.abs(delta.pct).toFixed(0)}%`
      : `${delta.delta > 0 ? "+" : ""}${delta.delta}`;
  return (
    <span
      className={`flex items-center gap-1 font-mono text-[11px] tabular-nums tracking-[0.04em] ${tone}`}
      data-testid="delta-badge"
      data-direction={delta.direction}
      aria-label={`${up ? "up" : "down"} ${text} vs previous period`}
    >
      <span aria-hidden>{arrow}</span>
      {text}
    </span>
  );
}

export function MiniBars({
  rows,
  label,
}: {
  rows: { label: string; value: number }[];
  label: string;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  if (rows.length === 0) {
    return <p className="text-[12px] text-text-3">None recorded</p>;
  }
  return (
    <div className="flex flex-col gap-2" aria-label={label}>
      {rows.map((row) => {
        const pct = max <= 0 ? 0 : (row.value / max) * 100;
        return (
          <div
            key={row.label}
            className="flex items-center gap-3"
            data-testid="mini-bar"
            data-label={row.label}
            data-value={row.value}
          >
            <span className="w-32 shrink-0 truncate text-[12px] text-text-2">
              {row.label}
            </span>
            <span
              className="relative h-2 flex-1 overflow-hidden rounded-[2px] bg-surface-2"
              aria-hidden
            >
              <span
                className="absolute inset-y-0 left-0 rounded-[2px] bg-accent"
                style={{ width: `${pct}%` }}
                data-testid="mini-bar-fill"
              />
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-text">
              {formatCompact(row.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
