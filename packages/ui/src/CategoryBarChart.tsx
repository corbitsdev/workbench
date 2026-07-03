import { type ReactNode } from "react";
import { seriesColor } from "./chart-palette";

export interface CategoryDatum {
  /** Category label (also the React key — must be unique within the chart). */
  label: string;
  value: number;
  /** Optional node rendered in place of the plain label (e.g. a link). */
  labelNode?: ReactNode;
}

interface CategoryBarChartProps {
  data: CategoryDatum[];
  /** Accessible summary of what the bars show. */
  label: string;
  /**
   * When true each bar takes the next categorical palette slot (identity
   * encoding — e.g. per-kind). When false all bars share the accent tone
   * (magnitude-only — e.g. top actors ranked by one measure). Defaults false.
   */
  colorByCategory?: boolean;
  maxBars?: number;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

/**
 * Tokenized horizontal bar chart for categorical magnitude (per-kind breakdown,
 * top-actors). Bars are sorted descending by the caller. Color is semantic, not
 * decorative: magnitude-only bars share the accent tone, identity bars step the
 * fixed palette. A visually-hidden table mirrors every row so the ranking is
 * legible without color.
 */
export function CategoryBarChart({
  data,
  label,
  colorByCategory = false,
  maxBars = 12,
  formatValue = (v) => v.toLocaleString(),
  emptyMessage = "None recorded",
}: CategoryBarChartProps) {
  if (data.length === 0) {
    return (
      <div
        className="text-[12px] text-text-3"
        data-testid="category-bar-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  const rows = data.slice(0, maxBars);
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);

  return (
    <figure
      className="flex flex-col gap-2"
      data-testid="category-bar-chart"
      role="group"
      aria-label={label}
    >
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const pct = max <= 0 ? 0 : (row.value / max) * 100;
          const bg = colorByCategory ? seriesColor(i).bg : "bg-accent";
          return (
            <div
              key={row.label}
              className="flex items-center gap-3"
              data-testid="category-bar"
              data-label={row.label}
              data-value={row.value}
            >
              <span className="w-40 shrink-0 truncate text-[12px] text-text-2">
                {row.labelNode ?? row.label}
              </span>
              <span
                className="relative h-2.5 flex-1 overflow-hidden rounded-[3px] bg-surface-2"
                aria-hidden
              >
                <span
                  className={`absolute inset-y-0 left-0 rounded-[3px] ${bg}`}
                  style={{ width: `${pct}%` }}
                  data-testid="category-bar-fill"
                />
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-text">
                {formatValue(row.value)}
              </span>
            </div>
          );
        })}
      </div>
      <table className="sr-only" data-testid="category-bar-table">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{formatValue(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
