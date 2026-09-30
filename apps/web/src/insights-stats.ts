// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { runOutcomeStatus, withListingAbandoned } from "@corbits/workflows/client";

import type { InsightsRun } from "./insights-api";

/** Compact integer; null/undefined → em-dash. Lifted out of the deleted
 * `@corbits/insights/client` — this app's own copy since it has
 * no other browser-safe home now that the package is gone. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/** "1.2s" / "3.4m" duration label — same lift as `formatCount` above. */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Identity pass: the native `GET /workflows/runs` feed already excludes
// non-top-level runs, kept only for callers that still name it explicitly.
export function purposeRunsForInsights(runs: readonly InsightsRun[]): readonly InsightsRun[] {
  return runs;
}

// Falls back to definition name since the native feed carries no
// `routineName`; never mapped from a client-side lookup table.
export function runDisplayName(run: InsightsRun): string {
  return run.routineName ?? run.definitionName;
}

// Keeps runs whose `createdAt` falls inside `[fromIso, toIso]`; invalid
// timestamps are dropped so KPIs never invent rows.
export type DefinitionRunGroup = {
  /** `routineId` when set, else `definitionId` — kept distinct so two
   * routines sharing one definition never merge into one group. */
  readonly groupKey: string;
  readonly displayName: string;
  /** Newest run first. */
  readonly runs: readonly InsightsRun[];
};

// Client-side grouping of already-fetched runs, no new endpoint. Every
// group is definition-keyed today since the native feed lacks routine
// attribution; the routine branch rejoins once a fires equivalent exists.
export function groupRunsByDefinition(runs: readonly InsightsRun[]): readonly DefinitionRunGroup[] {
  const byGroupKey = new Map<string, InsightsRun[]>();
  for (const run of runs) {
    const groupKey = run.routineId ?? run.definitionId;
    const bucket = byGroupKey.get(groupKey);
    if (bucket === undefined) {
      byGroupKey.set(groupKey, [run]);
    } else {
      bucket.push(run);
    }
  }
  const groups = [...byGroupKey.entries()].map(([groupKey, group]) => {
    const runs = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Name from the newest run, after sorting — a routine or definition
    // rename must show the current name in the group header, not
    // whatever name its oldest fetched run happened to carry.
    return {
      groupKey,
      displayName: runs[0] !== undefined ? runDisplayName(runs[0]) : groupKey,
      runs,
    };
  });
  return groups.sort((a, b) =>
    (b.runs[0]?.createdAt ?? "").localeCompare(a.runs[0]?.createdAt ?? ""),
  );
}

export const BENCH_RANGES = [7, 30, 90] as const;
export type BenchRange = (typeof BENCH_RANGES)[number];

const DAY_MS = 86_400_000;

export type BenchDay = {
  readonly date: Date;
  readonly ok: number;
  readonly fail: number;
  /** Runs still going, stopped, or otherwise neither succeeded nor failed. */
  readonly other: number;
};
export type BenchWorkflowRow = {
  readonly key: string;
  readonly name: string;
  readonly runs: number;
  readonly ok: number;
  readonly fail: number;
  readonly medianMs: number | null;
  readonly lastRun: string;
};
export type BenchInsights = {
  readonly total: number;
  readonly ok: number;
  readonly fail: number;
  readonly medianMs: number | null;
  readonly days: readonly BenchDay[];
  readonly workflows: readonly BenchWorkflowRow[];
  readonly failures: readonly InsightsRun[];
};

export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

function runDurationMs(run: InsightsRun): number | null {
  if (run.endedAt === undefined || run.endedAt === null) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.createdAt);
  return Number.isNaN(ms) || ms < 0 ? null : ms;
}

type Bucket = "ok" | "fail" | "other";
function bucketOf(run: InsightsRun, now: number): Bucket {
  const outcome = runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
  if (outcome === "completed") return "ok";
  if (outcome === "failed" || outcome === "error") return "fail";
  return "other";
}

/** Rollups over the runs created in the last `range` local days (today
 * included). "Other" outcomes (running, stopped) count as runs and get their
 * own chart segment, but are neither succeeded nor failed. */
export function computeBenchInsights(
  runs: readonly InsightsRun[],
  range: BenchRange,
  now: number = Date.now(),
): BenchInsights {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days: { date: Date; ok: number; fail: number; other: number }[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    days.push({ date, ok: 0, fail: 0, other: 0 });
  }
  const start = days[0]?.date.getTime() ?? 0;

  const inRange = runs.filter((run) => {
    const t = Date.parse(run.createdAt);
    return !Number.isNaN(t) && t >= start && t <= now;
  });
  let ok = 0;
  let fail = 0;
  const groups = new Map<string, InsightsRun[]>();
  for (const run of inRange) {
    const bucket = bucketOf(run, now);
    const midnight = new Date(run.createdAt);
    midnight.setHours(0, 0, 0, 0);
    // round, not floor: DST days are 23h or 25h long.
    const day = days[Math.round((midnight.getTime() - start) / DAY_MS)];
    if (bucket === "ok") {
      ok += 1;
      if (day !== undefined) day.ok += 1;
    } else if (bucket === "fail") {
      fail += 1;
      if (day !== undefined) day.fail += 1;
    } else if (day !== undefined) {
      day.other += 1;
    }
    const key = run.routineId ?? run.definitionId;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const durations = (rs: readonly InsightsRun[]) =>
    rs.flatMap((r) => {
      const d = runDurationMs(r);
      return d === null ? [] : [d];
    });
  const workflows = [...groups.entries()]
    .map(([key, rs]) => {
      const newest = [...rs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        key,
        name: newest[0] !== undefined ? runDisplayName(newest[0]) : key,
        runs: rs.length,
        ok: rs.filter((r) => bucketOf(r, now) === "ok").length,
        fail: rs.filter((r) => bucketOf(r, now) === "fail").length,
        medianMs: medianMs(durations(rs)),
        lastRun: newest[0]?.createdAt ?? "",
      };
    })
    .sort((a, b) => b.lastRun.localeCompare(a.lastRun));

  return {
    total: inRange.length,
    ok,
    fail,
    medianMs: medianMs(durations(inRange)),
    days,
    workflows,
    failures: inRange
      .filter((r) => bucketOf(r, now) === "fail")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5),
  };
}
