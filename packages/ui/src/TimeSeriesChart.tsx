import { useId } from "react";
import { seriesColor } from "./chart-palette";
import {
  buildAreaPath,
  buildLinePath,
  niceMax,
  seriesToCoords,
} from "./chart-geometry";

export interface TimeSeriesPoint {
  /** x-axis label for this point (e.g. an ISO date). */
  label: string;
  value: number;
}

export interface TimeSeries {
  /** Stable series key (also the React key). */
  key: string;
  /** Human name shown in the legend and the table fallback. */
  name: string;
  points: TimeSeriesPoint[];
}

interface TimeSeriesChartProps {
  series: TimeSeries[];
  /** Accessible summary of what the chart shows. */
  label: string;
  variant?: "line" | "area";
  height?: number;
  width?: number;
  /** Formats a value for the table fallback and aria summary. */
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

const VIEW_WIDTH = 640;

/**
 * Tokenized SVG line/area chart for change-over-time. Colors come from the
 * fixed categorical palette (never hardcoded); a single series carries no
 * legend (the title names it) while multiple series each get a swatch. Identity
 * is never color-alone: a visually-hidden data table lists every point so the
 * chart is legible to screen readers and stands in for a print/CVD fallback.
 */
export function TimeSeriesChart({
  series,
  label,
  variant = "area",
  height = 140,
  width = VIEW_WIDTH,
  formatValue = (v) => v.toLocaleString(),
  emptyMessage = "No data for this range",
}: TimeSeriesChartProps) {
  const tableId = useId();
  const nonEmpty = series.filter((s) => s.points.length > 0);
  const hasData = nonEmpty.some((s) => s.points.some((p) => p.value !== 0));

  if (nonEmpty.length === 0 || !hasData) {
    return (
      <div className="text-[12px] text-text-3" data-testid="time-series-empty">
        {emptyMessage}
      </div>
    );
  }

  const globalMax = niceMax(
    Math.max(0, ...nonEmpty.flatMap((s) => s.points.map((p) => p.value))),
  );
  const labels = nonEmpty[0]!.points.map((p) => p.label);
  const peak = Math.max(
    ...nonEmpty.flatMap((s) => s.points.map((p) => p.value)),
  );
  const showLegend = nonEmpty.length >= 2;

  return (
    <figure className="flex flex-col gap-2" data-testid="time-series-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}. Peak ${formatValue(peak)} across ${labels.length} buckets.`}
        aria-describedby={tableId}
        data-series-count={nonEmpty.length}
      >
        <line
          x1={0}
          y1={height - 0.5}
          x2={width}
          y2={height - 0.5}
          className="stroke-border"
          strokeWidth={1}
        />
        {nonEmpty.map((s, i) => {
          const color = seriesColor(i);
          const coords = seriesToCoords(
            s.points.map((p) => p.value),
            width,
            height,
            globalMax,
          );
          return (
            <g key={s.key} data-testid="time-series-line" data-series={s.key}>
              {variant === "area" && (
                <path
                  d={buildAreaPath(coords, height)}
                  className={color.fill}
                  opacity={0.14}
                />
              )}
              <path
                d={buildLinePath(coords)}
                fill="none"
                className={color.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}
      </svg>

      {showLegend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {nonEmpty.map((s, i) => (
            <span
              key={s.key}
              data-testid="time-series-legend"
              className="flex items-center gap-1.5 text-[11px] text-text-2"
            >
              <span
                aria-hidden
                className={`h-2 w-2 rounded-[1px] ${seriesColor(i).bg}`}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <table id={tableId} className="sr-only" data-testid="time-series-table">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            {nonEmpty.map((s) => (
              <th key={s.key} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((rowLabel, rowIndex) => (
            <tr key={rowLabel}>
              <th scope="row">{rowLabel}</th>
              {nonEmpty.map((s) => (
                <td key={s.key}>
                  {formatValue(s.points[rowIndex]?.value ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
