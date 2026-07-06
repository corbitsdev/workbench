import type { MetricsPoint } from "../../lib/hub-api";

const CSV_HEADER = [
  "date",
  "agents_deployed",
  "agents_active",
  "tokens_spent",
  "artifacts_created",
] as const;

/** RFC-4180 escape: quote a field only when it contains a comma, quote, or newline. */
function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serializes the Insights metrics series to CSV. Columns match the ask —
 * per-bucket agents deployed (new), agents active (did work), tokens spent,
 * and artifacts created. `bucketStart` is the row's date label.
 */
export function buildMetricsCsv(series: MetricsPoint[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const point of series) {
    lines.push(
      [
        escapeField(point.bucketStart),
        String(point.agentsDeployed),
        String(point.agentsActive),
        String(point.tokensSpent),
        String(point.artifactsCreated),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Filename for a metrics export over the given resolved range. */
export function metricsCsvFilename(range: {
  startDate?: string;
  endDate?: string;
}): string {
  const start = range.startDate ?? "all";
  const end = range.endDate ?? new Date().toISOString().slice(0, 10);
  return `insights-daily-${start}_${end}.csv`;
}
