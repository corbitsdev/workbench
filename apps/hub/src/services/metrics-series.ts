import type { AnalyticsDateRange } from "@workbench/analytics";

/**
 * Bucket granularity for the Insights daily-metrics series (CL-2836). `day` is
 * the default and the only one the dashboard exports today; `week`/`month` are
 * rolled up from the same per-day source so the follow-up CSV endpoint (CL-2838)
 * needs no new query.
 */
export type MetricsBucket = "day" | "week" | "month";

export function isMetricsBucket(value: string): value is MetricsBucket {
  return value === "day" || value === "week" || value === "month";
}

export type MetricsPoint = {
  /** Calendar start of the bucket, `YYYY-MM-DD` (UTC). Stable key and label. */
  bucketStart: string;
  /** Agent instances first created within this bucket (new deployments). */
  agentsDeployed: number;
  /** Distinct agent instances that recorded work (turns) within this bucket. */
  agentsActive: number;
  /** Total tokens (all five classes) recorded in this bucket. */
  tokensSpent: number;
  /** Artifacts created within this bucket. */
  artifactsCreated: number;
};

/**
 * One instance's activity on one day, from the analytics rollup. Used to count
 * agents that actually did work in a bucket — NOT mere existence. `endedAt` on
 * `agent_instance` is essentially never stamped in this system (the idle reaper
 * is forbidden from setting it), so a lifespan-overlap "active" count would
 * degenerate into a monotonic "every instance ever created" line. Activity days
 * come from turns recorded per instance per day, which is the honest signal.
 */
export type ActiveInstanceDay = { instanceId: string; date: string };

/** Per-day token total (all classes summed), from the analytics rollup. */
export type TokenDayTotal = { date: string; tokens: number };

/** The five token classes carried on an analytics daily point. */
export type TokenClasses = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

/** Total tokens across all five classes — the `tokensSpent` value per bucket. */
export function sumTokenClasses(point: TokenClasses): number {
  return (
    point.inputTokens +
    point.outputTokens +
    point.cacheReadTokens +
    point.cacheWriteTokens +
    point.thinkingTokens
  );
}

const MS_PER_DAY = 86_400_000;

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return toDateStr(new Date(toUtc(date).getTime() + n * MS_PER_DAY));
}

function startOfWeek(date: string): string {
  const d = toUtc(date);
  // Monday-anchored: getUTCDay() has Sunday=0, so (day + 6) % 7 makes Monday=0.
  const offset = (d.getUTCDay() + 6) % 7;
  return toDateStr(new Date(d.getTime() - offset * MS_PER_DAY));
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function bucketStartOf(date: string, bucket: MetricsBucket): string {
  if (bucket === "week") return startOfWeek(date);
  if (bucket === "month") return startOfMonth(date);
  return date;
}

function bucketEndOf(bucketStart: string, bucket: MetricsBucket): string {
  if (bucket === "week") return addDays(bucketStart, 6);
  if (bucket === "month") {
    const d = toUtc(bucketStart);
    return toDateStr(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)),
    );
  }
  return bucketStart;
}

function resolveBounds(args: {
  range: AnalyticsDateRange;
  today: string;
  artifactDates: string[];
  deployedDates: string[];
  activeInstanceDays: ActiveInstanceDay[];
  tokenDaily: TokenDayTotal[];
}): { start: string; end: string } | null {
  const end = args.range.endDate ?? args.today;
  let start = args.range.startDate;
  if (start === undefined) {
    // All-time: anchor the spine at the earliest date any metric has data, so
    // an open range doesn't enumerate from epoch.
    let earliest: string | undefined;
    const consider = (d: string) => {
      if (earliest === undefined || d < earliest) earliest = d;
    };
    for (const d of args.artifactDates) consider(d);
    for (const d of args.deployedDates) consider(d);
    for (const a of args.activeInstanceDays) consider(a.date);
    for (const t of args.tokenDaily) consider(t.date);
    if (earliest === undefined) return null;
    start = earliest;
  }
  if (start > end) return null;
  return { start, end };
}

/**
 * Builds a continuous, gap-filled per-bucket metrics series over the range.
 * Every bucket in `[start, end]` is emitted (zeros where nothing happened) so
 * the dashboard and CSV never draw false slopes or drop empty days.
 *
 * `agentsActive` counts DISTINCT instances that did work in the bucket (an
 * instance active on three days of a week counts once for that week), so
 * week/month roll-ups cannot be produced by summing daily counts. All date
 * arithmetic is UTC; `YYYY-MM-DD` strings compare chronologically.
 *
 * Known limitation (CL-2838): for `week`/`month`, a range whose edge falls
 * mid-bucket emits a row labeled with the calendar bucket start but summing
 * only the in-range days — a partial bucket shown as a whole one. The dashboard
 * only exposes `day` today (every bucket is one day, no partials); the
 * week/month toggle in CL-2838 must snap the range to bucket boundaries or mark
 * partial buckets before surfacing them.
 */
export function buildMetricsSeries(args: {
  bucket: MetricsBucket;
  range: AnalyticsDateRange;
  today: string;
  artifactDates: string[];
  /** Instance created-at dates (new deployments). */
  deployedDates: string[];
  /** Per-instance activity days (did-work signal for `agentsActive`). */
  activeInstanceDays: ActiveInstanceDay[];
  tokenDaily: TokenDayTotal[];
}): MetricsPoint[] {
  const bounds = resolveBounds(args);
  if (bounds === null) return [];
  const { start, end } = bounds;
  const {
    bucket,
    deployedDates,
    activeInstanceDays,
    artifactDates,
    tokenDaily,
  } = args;

  const points: MetricsPoint[] = [];
  let cursor = bucketStartOf(start, bucket);
  while (cursor <= end) {
    const calEnd = bucketEndOf(cursor, bucket);
    const winStart = cursor < start ? start : cursor;
    const winEnd = calEnd > end ? end : calEnd;

    let agentsDeployed = 0;
    for (const d of deployedDates) {
      if (d >= winStart && d <= winEnd) agentsDeployed++;
    }

    const activeInstances = new Set<string>();
    for (const a of activeInstanceDays) {
      if (a.date >= winStart && a.date <= winEnd)
        activeInstances.add(a.instanceId);
    }

    let artifactsCreated = 0;
    for (const d of artifactDates) {
      if (d >= winStart && d <= winEnd) artifactsCreated++;
    }

    let tokensSpent = 0;
    for (const t of tokenDaily) {
      if (t.date >= winStart && t.date <= winEnd) tokensSpent += t.tokens;
    }

    points.push({
      bucketStart: cursor,
      agentsDeployed,
      agentsActive: activeInstances.size,
      tokensSpent,
      artifactsCreated,
    });
    cursor = bucketStartOf(addDays(calEnd, 1), bucket);
  }
  return points;
}
