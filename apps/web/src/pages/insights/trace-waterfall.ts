import type { LogStepState } from "../../lib/run-state-adapter";

// Honest span: null unless BOTH boundaries are present and the span is
// non-negative (the record model never guarantees an end timestamp).
export function formatStepDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
): string | null {
  if (startedAt === undefined || endedAt === undefined) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function parseTimestamp(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds between boundaries, or null — same honesty rules as formatStepDuration. */
export function stepSpanMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
): number | null {
  if (startedAt === undefined || endedAt === undefined) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms;
}

export type TraceWaterfallRow = {
  index: number;
  step: LogStepState;
  startMs: number | null;
  spanMs: number | null;
  durationLabel: string | null;
  missingEnd: boolean;
  missingStart: boolean;
};

export type TraceWaterfallLayout = {
  originMs: number;
  totalSpanMs: number;
  rows: TraceWaterfallRow[];
};

/**
 * Positions each step on a shared axis using only recorded timestamps — never
 * fabricates an end time for in-flight or open steps.
 */
export function buildTraceWaterfallLayout(
  steps: LogStepState[],
): TraceWaterfallLayout {
  const timestamps: number[] = [];
  for (const step of steps) {
    const start = parseTimestamp(step.startedAt);
    const end = parseTimestamp(step.endedAt);
    if (start !== null) timestamps.push(start);
    if (end !== null) timestamps.push(end);
  }

  const originMs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const endMs = timestamps.length > 0 ? Math.max(...timestamps) : originMs;
  const totalSpanMs = Math.max(endMs - originMs, 1);

  const rows: TraceWaterfallRow[] = steps.map((step, index) => {
    const startMs = parseTimestamp(step.startedAt);
    const spanMs = stepSpanMs(step.startedAt, step.endedAt);
    return {
      index,
      step,
      startMs,
      spanMs,
      durationLabel: formatStepDuration(step.startedAt, step.endedAt),
      missingEnd: step.startedAt !== undefined && step.endedAt === undefined,
      missingStart: step.startedAt === undefined,
    };
  });

  return { originMs, totalSpanMs, rows };
}

export function waterfallBarStyle(
  layout: TraceWaterfallLayout,
  row: TraceWaterfallRow,
): { leftPercent: number; widthPercent: number } | null {
  if (row.spanMs === null || row.startMs === null) return null;
  const leftPercent =
    ((row.startMs - layout.originMs) / layout.totalSpanMs) * 100;
  const widthPercent = (row.spanMs / layout.totalSpanMs) * 100;
  return {
    leftPercent: Math.min(Math.max(leftPercent, 0), 100),
    widthPercent: Math.min(Math.max(widthPercent, 0.5), 100 - leftPercent),
  };
}