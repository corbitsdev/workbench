/**
 * Categorical chart palette, expressed as tokenized Tailwind class names so a
 * chart series is painted from the brand design tokens (`styles.css`) and stays
 * coherent across every theme — never a hardcoded hex.
 *
 * The slot order is FIXED and never cycled: a series keeps its color regardless
 * of how many other series are present, and an index past the last slot clamps
 * to the final slot rather than wrapping (dataviz: a 9th series folds into
 * "Other", it is never a repainted hue). Assign by the entity's stable position,
 * not by its rank in the current view.
 */
export interface ChartSeriesColor {
  /** Stable token family key (also a good React key / test hook). */
  key: string;
  /** `stroke-*` class for SVG line/path strokes. */
  stroke: string;
  /** `fill-*` class for SVG fills. */
  fill: string;
  /** `text-*` class for text/currentColor marks. */
  text: string;
  /** `bg-*` class for legend swatches and bar fills. */
  bg: string;
}

// CVD-aware order. Blue leads as the neutral primary data/magnitude hue. The
// accent (orange) family is excluded from the series rotation entirely — it is
// the ACTION color and must stay reserved for genuine action affordances, never
// painted onto a passive data series. Green- and red-family slots are kept
// non-adjacent — under deuteranopia adjacent green/red collapse into one hue, so
// they are separated by a blue and never neighbour each other.
export const CHART_SERIES: readonly ChartSeriesColor[] = [
  {
    key: "blue",
    stroke: "stroke-blue",
    fill: "fill-blue",
    text: "text-blue",
    bg: "bg-blue",
  },
  {
    key: "green",
    stroke: "stroke-green",
    fill: "fill-green",
    text: "text-green",
    bg: "bg-green",
  },
  {
    key: "green-deep",
    stroke: "stroke-green-deep",
    fill: "fill-green-deep",
    text: "text-green-deep",
    bg: "bg-green-deep",
  },
  {
    key: "blue-deep",
    stroke: "stroke-blue-deep",
    fill: "fill-blue-deep",
    text: "text-blue-deep",
    bg: "bg-blue-deep",
  },
  {
    key: "red",
    stroke: "stroke-red",
    fill: "fill-red",
    text: "text-red",
    bg: "bg-red",
  },
  {
    key: "red-deep",
    stroke: "stroke-red-deep",
    fill: "fill-red-deep",
    text: "text-red-deep",
    bg: "bg-red-deep",
  },
] as const;

/**
 * Color for series `index`, clamped to the final slot (never cycled). A negative
 * index resolves to the first slot.
 */
export function seriesColor(index: number): ChartSeriesColor {
  const clamped = index < 0 ? 0 : Math.min(index, CHART_SERIES.length - 1);
  return CHART_SERIES[clamped]!;
}
