// Insights over packages/insights: cost KPIs, activity bars, token mosaic,
// cost-by-model, calls-by-tool, recent purpose runs, runs history, and
// run-trace detail. Absent usage is zero metrics + zero day series
// (EMPTY_OVERALL_USAGE / activitySeriesForWindow). Null cost/rate still
// means "rate unknown" when turns exist — em-dash, not a fabricated cost.
// Stage layout mirrors the shell mock: KPI row → chart/card grid → recent runs.

import {
  Badge,
  BarChart,
  PageShell,
  RichEmptyState,
  Skeleton,
  StatGrid,
  StatGridItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TimeSeriesChart,
  TokenMosaic,
  TraceWaterfall,
  type TraceSpan,
} from "@corbits/react-ui";
import { ChartBar } from "@corbits/icons";
import type * as React from "react";
import { useEffect, useMemo, useState } from "react";

import {
  activitySeriesForWindow,
  createInsightsWindow,
  durationLabel,
  EMPTY_OVERALL_USAGE,
  formatCount,
  formatRate,
  formatUsd,
  INSIGHTS_WINDOW_DAYS,
  modelsWithMissingRates,
  tokensLabel,
  topModelsByCost,
  type DayActivity,
  type InsightsRange,
  type ModelUsage,
  type OverallUsage,
} from "@corbits/insights/client";

import { SignedOutNotice, type APIQuery } from "@corbits/api-query";
import {
  workbenchesQueryKey,
  listWorkbenches,
  type Workbench,
} from "@corbits/chat-ui";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import {
  workbenchIdForWorkbenchTenant,
  resolveWorkbenchInsightsScope,
  type WorkbenchInsightsResolution,
} from "../insights-workbench-scope";
import { workbenchInsightsPath } from "../insights-deeplinks";
import {
  ActivityResponseSchema,
  InsightsScopeSchema,
  LatencySummarySchema,
  OverallUsageSchema,
  RunTraceSchema,
  TaskLegsResponseSchema,
  TaskResponseSchema,
  ToolsResponseSchema,
  TopLevelRunsSchema,
  WorkbenchesResponseSchema,
  insightsActivityPath,
  insightsLatencyPath,
  insightsRunTracePath,
  insightsScopePath,
  insightsTaskByRunPath,
  insightsTaskLegsPath,
  insightsToolsPath,
  insightsTopLevelRunsPath,
  insightsUsagePath,
  insightsWorkbenchesPath,
  type InsightsRun,
  type InsightsScope,
  type LatencySummary,
  type RunTrace,
  type TaskLeg,
  type ToolCall,
  type WorkbenchUsage,
} from "../insights-api";
import {
  computeInsightsStats,
  computeTraceStats,
  filterRunsByCreatedAt,
  groupRunsByDefinition,
  legDurationMs,
  legStatusTone,
  purposeRunsForInsights,
  runDisplayName,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { tenantKeys } from "../query-client";
import { StageCrumbs, StageTopBar } from "../shell/stage-top-bar";
import { listRoutines, useTenantQuery, type Routine } from "../routines-api";
import { WorkbenchTimelineRoute } from "./workbench-timeline";

function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function statusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
    case "deployed":
      return "success";
    case "running":
    case "pending":
    case "awaiting":
    case "updating":
      return "info";
    case "failed":
    case "errored":
    case "error":
      return "danger";
    case "cancelled":
    case "stopped":
      return "warning";
    default:
      return "neutral";
  }
}

function tileValue(value: string | number | null, loading: boolean): string {
  if (loading) return "";
  if (value === null) return "—";
  return String(value);
}

/** "1.2s / 3.4s" for a latency stage's p50/p95, or an em-dash pair when
 * the stage recorded no samples in range (see LatencyStageStat). */
function latencyStatValue(stat: {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}): string {
  const p50 = stat.p50Ms === null ? "—" : durationLabel(stat.p50Ms);
  const p95 = stat.p95Ms === null ? "—" : durationLabel(stat.p95Ms);
  return `${p50} / ${p95}`;
}

function tokenParts(summary: OverallUsage) {
  const t = summary.tokens;
  return [
    { label: "Input", value: t.input },
    { label: "Output", value: t.output },
    { label: "Cache read", value: t.cacheRead },
    { label: "Cache write", value: t.cacheWrite },
    { label: "Thinking", value: t.thinking },
  ].filter((p) => p.value > 0);
}

export function toTraceSpans(trace: RunTrace): TraceSpan[] {
  if (trace.spans === null || trace.spans.length === 0) return [];
  const origin = Math.min(...trace.spans.map((s) => s.start), 0);
  const end = Math.max(...trace.spans.map((s) => s.end), origin + 1);
  const span = Math.max(1, end - origin);
  return trace.spans.map((s) => {
    const base = {
      id: s.id,
      label: s.label,
      kind: s.kind,
      start: (s.start - origin) / span,
      end: (s.end - origin) / span,
      durationLabel: s.durationMs === null ? null : durationLabel(s.durationMs),
      phase: s.phase,
      timingSource: s.timingSource,
    };
    const tok = tokensLabel(s.tokens);
    if (s.error !== null && tok !== undefined) {
      return { ...base, tokensLabel: tok, error: s.error };
    }
    if (s.error !== null) return { ...base, error: s.error };
    if (tok !== undefined) return { ...base, tokensLabel: tok };
    return base;
  });
}

function cacheHitRate(summary: OverallUsage): number | null {
  const t = summary.tokens;
  const denom = t.input + t.cacheRead;
  if (denom === 0) return null;
  return t.cacheRead / denom;
}

/** Weekday short label for a UTC YYYY-MM-DD activity day. */
function dayWeekdayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day.slice(5);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}

/** Prefer the most recent 7 buckets when the sink returns a longer window. */
function recentActivityDays(
  days: readonly DayActivity[],
  limit = 7,
): readonly DayActivity[] {
  if (days.length <= limit) return days;
  return days.slice(days.length - limit);
}

function runsDetailLabel(stats: {
  readonly running: number;
  readonly errored: number;
}): string {
  if (stats.running > 0) {
    return `${formatCount(stats.running)} running`;
  }
  if (stats.errored > 0) {
    return `${formatCount(stats.errored)} errored`;
  }
  return "purpose workflows";
}

function InsightsStat({
  label,
  value,
  detail,
  onClick,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
  readonly loading?: boolean;
}) {
  if (loading === true) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
        <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-muted-foreground">
          {label}
        </span>
        <Skeleton className="h-[26px] w-16" />
      </div>
    );
  }
  return (
    <StatGridItem
      label={label}
      value={value}
      {...(detail === undefined ? {} : { sub: detail })}
      {...(onClick === undefined ? {} : { onClick })}
    />
  );
}

/** Clickable-row semantics shared by the recent-runs and history tables —
 * mirrors react-ui's `DataTable` row affordance (button role, Enter/Space
 * activation) for tables fed by data already resident in this page. */
function onRowActivate(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    className: "cursor-pointer insights-row-clickable",
    onClick: onActivate,
    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

function ActivityBars({ days }: { readonly days: readonly DayActivity[] }) {
  const window = recentActivityDays(days);
  return (
    <BarChart
      title="Activity"
      description={`Last ${window.length} days`}
      data={window.map((d) => ({
        label: dayWeekdayLabel(d.day),
        value: d.turns,
      }))}
      valueLabel="Turns"
      format={formatCount}
    />
  );
}

/** Workbenches that recorded at least one turn in the window — the global
 * landing's "active workbenches" KPI. Never counts a workbench that only
 * exists (a leaf with zero usage) as active. */
function activeWorkbenchCount(workbenches: readonly WorkbenchUsage[]): number {
  return workbenches.filter((w) => w.turns > 0).length;
}

const WORKBENCH_BARS_LIMIT = 8;

/**
 * Ranked activity-by-workbench list: the tenancy-wide landing's answer to
 * "which workbenches are actually busy" — each row a mini bar (relative to
 * the busiest workbench in view) that opens that workbench's own scoped
 * view, same clickable-row affordance as the rest of this page
 * (`onRowActivate`) rather than a bespoke chart interaction.
 */
function WorkbenchActivityBars({
  workbenches,
  onSelectWorkbench,
}: {
  readonly workbenches: readonly WorkbenchUsage[];
  readonly onSelectWorkbench: (tenantId: string) => void;
}) {
  const ranked = [...workbenches]
    .sort((a, b) => b.turns - a.turns)
    .slice(0, WORKBENCH_BARS_LIMIT);
  const max = Math.max(1, ...ranked.map((w) => w.turns));

  return (
    <Table aria-label="Activity by workbench" className="insights-data-table">
      <TableBody>
        {ranked.map((workbench) => (
          <TableRow
            key={workbench.tenantId}
            {...onRowActivate(() => onSelectWorkbench(workbench.tenantId))}
          >
            <TableCell>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-semibold">
                  {workbench.name}
                </span>
                <div className="insights-workbench-bar-track">
                  <div
                    className="insights-workbench-bar-fill"
                    style={{ width: `${(workbench.turns / max) * 100}%` }}
                  />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCount(workbench.turns)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** "Done" folds every settled-without-error outcome (deployed and manually
 * stopped) together — the landing asks for done vs. failed, not a full
 * status breakdown (that detail stays on the KPI tiles / run history). */
function runOutcomeData(stats: {
  readonly deployed: number;
  readonly stopped: number;
  readonly errored: number;
  readonly running: number;
}) {
  return [
    { label: "Done", value: stats.deployed + stats.stopped },
    { label: "Failed", value: stats.errored },
    { label: "Running", value: stats.running },
  ];
}

/** Tokens-by-model series for the tokens-over-time chart — token volume
 * (unlike cost) is always a known number for a recorded turn, so this
 * stays honest for every model without a null-rate caveat. Capped to the
 * top models by cost (the models that matter most to the spend story),
 * same as `TimeSeriesChart`'s own "≤5 series" rule. */
function tokensOverTimeSeries(days: readonly DayActivity[]) {
  const models = topModelsByCost(days);
  return models.map((model) => ({
    label: model,
    values: days.map(
      (day) => day.byModel.find((m) => m.model === model)?.tokens ?? 0,
    ),
  }));
}

function ModelCostTable({
  models,
}: {
  readonly models: readonly ModelUsage[];
}) {
  return (
    <Table
      aria-label="Cost by model"
      className="insights-data-table insights-table-inert"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Input</TableHead>
          <TableHead>Cache read</TableHead>
          <TableHead>Output</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m) => (
          <TableRow key={m.model}>
            <TableCell title={m.model}>{m.model}</TableCell>
            <TableCell>
              {m.costUsd === null && m.tokens.total > 0
                ? "—"
                : formatUsd(m.costUsd)}
            </TableCell>
            <TableCell>{formatCount(m.tokens.input)}</TableCell>
            <TableCell>{formatCount(m.tokens.cacheRead)}</TableCell>
            <TableCell>{formatCount(m.tokens.output)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ToolCallsTable({ tools }: { readonly tools: readonly ToolCall[] }) {
  return (
    <Table
      aria-label="Calls by tool"
      className="insights-data-table insights-table-inert"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Calls</TableHead>
          <TableHead>Errors</TableHead>
          <TableHead>Error rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tools.map((t) => (
          <TableRow key={t.tool}>
            <TableCell title={t.tool}>{t.tool}</TableCell>
            <TableCell>{formatCount(t.calls)}</TableCell>
            <TableCell>{formatCount(t.errors)}</TableCell>
            <TableCell>{formatRate(t.errorRate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RecentRunRows({
  runs,
  onOpenRun,
  onOpenRuns,
}: {
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
}) {
  return (
    <Table aria-label="Recent runs" className="insights-data-table">
      <TableBody>
        {runs.map((row) => (
          <TableRow
            key={row.id}
            data-ctx-insights-run={row.id}
            {...onRowActivate(() => onOpenRun(row.id))}
          >
            <TableCell>
              <div className="flex min-w-0 flex-col gap-0.5">
                <strong className="truncate text-sm font-semibold">
                  {runDisplayName(row)}
                </strong>
                <span className="truncate text-xs text-muted-foreground">
                  {formatWhen(row.createdAt)}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <Badge tone={statusTone(row.status)}>{row.status}</Badge>
            </TableCell>
          </TableRow>
        ))}
        <TableRow {...onRowActivate(onOpenRuns)}>
          <TableCell
            colSpan={2}
            className="font-semibold text-primary-emphasis"
          >
            All runs & traces →
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function InsightsLanding({
  summary,
  activity,
  byModel,
  byTool,
  runs,
  routines,
  workbenches,
  latency,
  range,
  loading,
  onOpenRun,
  onOpenRuns,
  onSelectWorkbench,
}: {
  readonly summary: OverallUsage | null;
  readonly activity: readonly DayActivity[] | null;
  readonly byModel: readonly ModelUsage[] | null;
  readonly byTool: readonly ToolCall[] | null;
  readonly runs: readonly InsightsRun[];
  readonly routines: readonly Routine[];
  /** Null while `/workbenches` hasn't resolved (or this landing is already
   * scoped to one workbench, where a breakdown of one has nothing to
   * show) — the activity-by-workbench chart and active-workbenches KPI
   * both hide rather than render a fabricated single-row chart. */
  readonly workbenches: readonly WorkbenchUsage[] | null;
  /** Null while `/latency` (CL-6257) hasn't resolved. */
  readonly latency: LatencySummary | null;
  /** Same 7-day window as usage/activity/tools requests. */
  readonly range: InsightsRange;
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
  readonly onSelectWorkbench: (tenantId: string) => void;
}) {
  // KPI count + recent list only — history/detail keep full run list.
  const windowedRuns = filterRunsByCreatedAt(runs, range.from, range.to);
  const stats = computeInsightsStats(windowedRuns, routines);
  const purposeRuns = purposeRunsForInsights(windowedRuns);

  // Absent usage → zeros at the client boundary (never demo peaks / em-dash
  // for "no spend"). Real fetched summary is preserved when present.
  const usage = summary ?? EMPTY_OVERALL_USAGE;
  const mosaicParts = tokenParts(usage);
  const hitRate = cacheHitRate(usage);
  const missingRates = modelsWithMissingRates(usage);
  const activityDays = activitySeriesForWindow(activity ?? [], range);
  const models = byModel !== null && byModel.length > 0 ? byModel : null;
  const tools = byTool !== null && byTool.length > 0 ? byTool : null;
  const recent = purposeRuns.slice(0, 12);
  const tokensSeries = tokensOverTimeSeries(activityDays);
  const noUsageInWindow = !loading && usage.turns === 0;

  return (
    <div className="insights-layout">
      <StatGrid columns={4}>
        <InsightsStat
          label="Cost"
          value={tileValue(formatUsd(usage.costUsd), loading)}
          detail={`${formatCount(usage.tokens.total)} tokens`}
          loading={loading}
        />
        <InsightsStat
          label="Activity"
          value={tileValue(formatCount(usage.turns), loading)}
          detail="turns"
          loading={loading}
        />
        <InsightsStat
          label="Tokens in / out"
          value={tileValue(
            `${formatCount(usage.tokens.input)} / ${formatCount(usage.tokens.output)}`,
            loading,
          )}
          detail="input / output"
          loading={loading}
        />
        <InsightsStat
          label="Runs"
          value={tileValue(formatCount(stats.totalRuns), loading)}
          detail={runsDetailLabel(stats)}
          onClick={onOpenRuns}
          loading={loading}
        />
        {workbenches !== null ? (
          <InsightsStat
            label="Active workbenches"
            value={tileValue(
              `${formatCount(activeWorkbenchCount(workbenches))} / ${formatCount(workbenches.length)}`,
              loading,
            )}
            detail="with usage this window"
            loading={loading}
          />
        ) : null}
        {stats.running > 0 || loading ? (
          <InsightsStat
            label="Running now"
            value={tileValue(formatCount(stats.running), loading)}
            detail="in flight"
            loading={loading}
          />
        ) : null}
      </StatGrid>

      {latency !== null && latency.total.samples > 0 ? (
        <StatGrid columns={4}>
          <InsightsStat
            label="Turn latency (p50 / p95)"
            value={latencyStatValue(latency.total)}
            detail={`${formatCount(latency.total.samples)} turns`}
            loading={loading}
          />
          <InsightsStat
            label="To first token (p50 / p95)"
            value={latencyStatValue(latency.toFirstToken)}
            detail="inference start → first token"
            loading={loading}
          />
          <InsightsStat
            label="Reply after first token (p50 / p95)"
            value={latencyStatValue(latency.toReplyPosted)}
            detail="first token → reply posted"
            loading={loading}
          />
          {latency.toReactorStart.samples > 0 ? (
            <InsightsStat
              label="Cold start (p50 / p95)"
              value={latencyStatValue(latency.toReactorStart)}
              detail="message received → reactor start"
              loading={loading}
            />
          ) : null}
        </StatGrid>
      ) : null}

      {noUsageInWindow ? (
        <p className="insights-note">No usage recorded yet in this window.</p>
      ) : null}

      {missingRates.length > 0 ? (
        <p className="insights-note">
          Rates unknown for: {missingRates.join(", ")}. Those turns do not
          contribute a fabricated cost.
        </p>
      ) : null}

      <div className="insights-grid">
        <section className="insights-panel">
          <ActivityBars days={activityDays} />
        </section>

        {mosaicParts.length > 0 ? (
          <section className="insights-panel">
            <h3>Token mix</h3>
            <TokenMosaic parts={mosaicParts} label="Token usage by class" />
            <StatGrid columns={2} className="mt-3.5">
              <InsightsStat
                label="Cache hit"
                value={tileValue(formatRate(hitRate), false)}
                detail="cache read / (input + cache read)"
              />
              <InsightsStat
                label="Total tokens"
                value={formatCount(usage.tokens.total)}
                detail={`${formatCount(usage.turns)} turns`}
              />
            </StatGrid>
          </section>
        ) : null}

        {models !== null ? (
          <section className="insights-panel">
            <h3>Cost by model</h3>
            <ModelCostTable models={models} />
          </section>
        ) : null}

        {tools !== null ? (
          <section className="insights-panel">
            <h3>Calls by tool</h3>
            <ToolCallsTable tools={tools} />
          </section>
        ) : null}

        {tokensSeries.length > 0 ? (
          <section className="insights-panel">
            <TimeSeriesChart
              title="Tokens over time by model"
              description={`Last ${activityDays.length} days`}
              labels={activityDays.map((d) => dayWeekdayLabel(d.day))}
              series={tokensSeries}
              variant="area"
              format={formatCount}
            />
          </section>
        ) : null}

        {stats.totalRuns > 0 ? (
          <section className="insights-panel">
            <BarChart
              title="Run outcomes"
              description={`${formatCount(stats.totalRuns)} purpose runs`}
              data={runOutcomeData(stats)}
              valueLabel="Runs"
              format={formatCount}
            />
          </section>
        ) : null}

        {workbenches !== null && workbenches.length > 0 ? (
          <section className="insights-panel">
            <h3>Activity by workbench</h3>
            <WorkbenchActivityBars
              workbenches={workbenches}
              onSelectWorkbench={onSelectWorkbench}
            />
          </section>
        ) : null}
      </div>

      {recent.length > 0 ? (
        <section className="insights-section">
          <div className="insights-section-head">
            <h2>Recent runs</h2>
          </div>
          <RecentRunRows
            runs={recent}
            onOpenRun={onOpenRun}
            onOpenRuns={onOpenRuns}
          />
        </section>
      ) : null}
    </div>
  );
}

export function runDurationLabel(run: InsightsRun): string {
  if (run.endedAt === undefined || run.endedAt === null) return "—";
  const startMs = Date.parse(run.createdAt);
  const endMs = Date.parse(run.endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "—";
  return durationLabel(Math.max(0, endMs - startMs));
}

function DefinitionRunTable({
  groupKey,
  displayName,
  runs,
  onOpenRun,
}: {
  readonly groupKey: string;
  readonly displayName: string;
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
}) {
  return (
    <section className="insights-panel" data-definition-group={groupKey}>
      <h3>{displayName}</h3>
      <Table aria-label={displayName} className="insights-data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((row) => (
            <TableRow
              key={row.id}
              data-ctx-insights-run={row.id}
              {...onRowActivate(() => onOpenRun(row.id))}
            >
              <TableCell>
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
              </TableCell>
              <TableCell>{formatWhen(row.createdAt)}</TableCell>
              <TableCell>{runDurationLabel(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function InsightsRunsHistory({
  runs,
  loading,
  nextCursor,
  onOpenRun,
  onBack,
}: {
  readonly runs: readonly InsightsRun[];
  readonly loading: boolean;
  /** The feed's own `nextCursor` (from `insightsTopLevelRunsPath`'s
   * `limit=100` fetch) — non-null means more runs exist than were fetched,
   * so the view says so instead of silently truncating at 100. */
  readonly nextCursor: string | null;
  readonly onOpenRun: (id: string) => void;
  readonly onBack: () => void;
}) {
  const purpose = purposeRunsForInsights(runs);
  const groups = groupRunsByDefinition(purpose);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={
          <StageCrumbs
            crumbs={[
              { label: "Insights", onSelect: onBack },
              { label: "Run history" },
            ]}
          />
        }
        subtitle={`${purpose.length} purpose runs`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : groups.length === 0 ? (
              <RichEmptyState
                icon={<ChartBar />}
                title="No purpose runs yet"
                description="When a routine or purpose workflow fires, it shows up here."
              />
            ) : (
              <>
                <div className="insights-grid">
                  {groups.map((group) => (
                    <DefinitionRunTable
                      key={group.groupKey}
                      groupKey={group.groupKey}
                      displayName={group.displayName}
                      runs={group.runs}
                      onOpenRun={onOpenRun}
                    />
                  ))}
                </div>
                {nextCursor !== null ? (
                  <p className="insights-note">
                    Showing the 100 most recent runs.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

// A chain step strip for a linear task chain only — CL-5514 tracks parent →
// child dispatch trees (real branching, not a straight hand-off sequence)
// as future scope; this renders `legs` as a flat ordered sequence and
// assumes there is exactly one "next" leg per position, same as the route
// this reads from (`GET /tasks/:id/legs` in packages/tasks/src/routes.ts).
// The strip reflects the legs query's own cache — up to 30s stale, or
// refreshed on window refocus (see `createAppQueryClient` in
// `../query-client.ts`) — not a live subscription; for a chain that is
// actively progressing that's a deliberate read-mostly trade-off, not a bug.
function TaskChainStrip({
  legs,
  currentRunId,
  onOpenRun,
}: {
  readonly legs: readonly TaskLeg[];
  readonly currentRunId: string;
  readonly onOpenRun: (runId: string) => void;
}) {
  return (
    <section className="insights-panel" data-insights-chain-strip="true">
      <h3>Chain steps</h3>
      <ol className="insights-chain-strip">
        {legs.map((leg) => {
          const isCurrent = leg.runId === currentRunId;
          const durationMs = legDurationMs(leg);
          const body = (
            <>
              <span className="insights-chain-step-title">
                {`Step ${leg.position + 1} of ${legs.length}`}
                <span className="insights-chain-step-agent">
                  {leg.definitionId}
                </span>
              </span>
              <Badge tone={legStatusTone(leg.status)}>{leg.status}</Badge>
              <span className="insights-chain-step-duration">
                {durationMs === null ? "—" : durationLabel(durationMs)}
              </span>
            </>
          );
          if (leg.runId === null) {
            return (
              <li
                key={leg.position}
                data-chain-step
                aria-current={isCurrent ? "step" : undefined}
                data-current={isCurrent}
                className="insights-chain-step"
              >
                {body}
              </li>
            );
          }
          return (
            <li key={leg.position}>
              <button
                type="button"
                data-chain-step
                aria-current={isCurrent ? "step" : undefined}
                data-current={isCurrent}
                className="insights-chain-step insights-chain-step-clickable"
                onClick={() => onOpenRun(leg.runId as string)}
              >
                {body}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function InsightsRunDetail({
  runId,
  run,
  trace,
  chainLegs,
  chainLookupFailed = false,
  onOpenRun,
  onBack,
}: {
  readonly runId: string;
  readonly run: InsightsRun | null;
  readonly trace: APIQuery<RunTrace>;
  /** Ordered legs for the owning task, or null when this run has no
   * owning task, or the task has never been fetched. A single-leg task's
   * legs are still passed through — the strip itself hides for
   * `legs.length <= 1` so a chain-less run renders unchanged. */
  readonly chainLegs: readonly TaskLeg[] | null;
  /** True when the by-run chain-context lookup failed for a reason other
   * than "this run has no owning task" (a genuine 404, the quiet no-op) —
   * a 500 or a network failure. Never silently omitted: renders a small
   * honest note instead of just leaving the strip out. */
  readonly chainLookupFailed?: boolean;
  readonly onOpenRun: (runId: string) => void;
  readonly onBack: () => void;
}) {
  const spans = trace.kind === "ready" ? toTraceSpans(trace.data) : [];
  const traceStats =
    trace.kind === "ready" && !("absent" in trace.data)
      ? computeTraceStats(trace.data.spans)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={
          <StageCrumbs
            crumbs={[
              { label: "Runs", onSelect: onBack },
              { label: run !== null ? runDisplayName(run) : runId },
            ]}
          />
        }
        subtitle={run !== null ? formatWhen(run.createdAt) : null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            {chainLegs !== null && chainLegs.length > 1 ? (
              <TaskChainStrip
                legs={chainLegs}
                currentRunId={runId}
                onOpenRun={onOpenRun}
              />
            ) : null}
            {chainLookupFailed ? (
              <p className="insights-note">
                Couldn't check this run's task context.
              </p>
            ) : null}
            <StatGrid columns={5}>
              {/* Owner is not carried by WorkflowRunResponse yet — dash, not
                  a fabricated identity. */}
              <InsightsStat label="Owner" value="—" />
              <InsightsStat
                label="Steps"
                value={dash(traceStats?.steps ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Completed"
                value={dash(traceStats?.completed ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Failed"
                value={dash(traceStats?.failed ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Duration"
                value={dash(
                  traceStats !== null
                    ? durationLabel(traceStats.durationMs)
                    : null,
                )}
                loading={trace.kind === "loading"}
              />
            </StatGrid>

            {trace.kind === "loading" ? (
              <Skeleton className="h-48 w-full" />
            ) : null}
            {trace.kind === "error" ? (
              <RichEmptyState
                title="Trace not available"
                description={
                  trace.message.includes("404") ||
                  trace.message.toLowerCase().includes("not found")
                    ? "No span data is recorded for this run yet. Pre-sink history is absent on purpose — not shown as zeros."
                    : trace.message
                }
              />
            ) : null}
            {trace.kind === "unauthenticated" ? <SignedOutNotice /> : null}
            {trace.kind === "ready" && spans.length > 0 ? (
              <section className="insights-panel">
                <h3>Timeline</h3>
                <TraceWaterfall
                  title="Run trace"
                  spans={spans}
                  description={`${spans.length} span${spans.length === 1 ? "" : "s"}`}
                />
              </section>
            ) : null}
            {trace.kind === "ready" && spans.length === 0 ? (
              <RichEmptyState
                title="Empty trace"
                description="The run exists but has no recorded spans yet."
              />
            ) : null}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

/**
 * `/insights/workbench/:workbenchId` (CL-5879) is its own dedicated route — a
 * conversation's own scoped view, resolved by `InsightsWorkbenchPage`, never
 * a sub-mode of the landing. Every other path stays the cross-workbench
 * default landing: no per-mode branch needed there, since scoping happens
 * in InsightsRoute (which tenantId every query below targets), not here.
 * A stale `/insights/workbench/:tenantId` link (that route is retired,
 * hard cut) falls through to the plain landing default below rather than
 * matching anything.
 */
function parseInsightsPath(path: string): {
  mode: "landing" | "runs" | "run" | "workbench";
  runId: string | null;
  workbenchId: string | null;
} {
  const workbenchMatch = /^\/insights\/workbench\/([^/]+)\/?$/.exec(path);
  if (workbenchMatch !== null && workbenchMatch[1] !== undefined) {
    return {
      mode: "workbench",
      runId: null,
      workbenchId: decodeURIComponent(workbenchMatch[1]),
    };
  }
  if (path === "/insights" || path === "/insights/") {
    return { mode: "landing", runId: null, workbenchId: null };
  }
  if (path === "/insights/runs" || path === "/insights/runs/") {
    return { mode: "runs", runId: null, workbenchId: null };
  }
  const match = /^\/insights\/runs\/([^/]+)\/?$/.exec(path);
  if (match !== null && match[1] !== undefined) {
    return {
      mode: "run",
      runId: decodeURIComponent(match[1]),
      workbenchId: null,
    };
  }
  return { mode: "landing", runId: null, workbenchId: null };
}

/**
 * The landing view's default scope, and every non-landing mode's scope,
 * as one pure decision so it can be unit-tested without mounting the
 * route. `/scope` (packages/insights/src/routes.ts) only ever reports a
 * `parent` when the caller holds an active principal in it — a present
 * parent means "caller is a workspace member" and the default becomes
 * the cross-workbench aggregate ("All workbenches"); otherwise the
 * default is the caller's own current workbench, labeled with its name.
 * Either way the result is always a tenant `/scope` itself vouches the
 * caller can see — there is no default that can 403.
 */
const WINDOW_REFRESH_MS = 60_000;

/** The insights [from, to] window, re-anchored to now once a minute. */
export function useInsightsWindow(): InsightsRange {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), WINDOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => createInsightsWindow(undefined, now), [now]);
}

export function resolveInsightsScope({
  mode,
  selectedTenantId,
  scopeData,
}: {
  readonly mode: "landing" | "runs" | "run" | "workbench";
  readonly selectedTenantId: string | null;
  readonly scopeData: InsightsScope | null;
}): { effectiveTenantId: string | null; scopeLabel: string } {
  if (mode !== "landing") {
    return {
      effectiveTenantId: selectedTenantId,
      scopeLabel: selectedTenantId ?? "",
    };
  }
  if (scopeData?.parent) {
    return {
      effectiveTenantId: scopeData.parent.tenantId,
      scopeLabel: "All workbenches",
    };
  }
  // The root tenancy with no parent IS the aggregate: every workbench's
  // runs land on it, so the landing view is all workbenches by
  // definition — label it that way instead of the tenant's own name,
  // which reads like a single workbench. Before `/scope` resolves this
  // falls back to the raw tenant id so the dashboard never blocks on it.
  if (scopeData !== null) {
    return {
      effectiveTenantId: scopeData.tenantId,
      scopeLabel: "All workbenches",
    };
  }
  return {
    effectiveTenantId: selectedTenantId,
    scopeLabel: selectedTenantId ?? "",
  };
}

/**
 * Landing-view scope switcher: "All workbenches" (the cross-workbench
 * aggregate this landing always shows — always the pressed option, since
 * every other pill navigates straight to that sibling's own workbench-scoped
 * Insights, CL-5879, rather than switching this same page's scope inline)
 * versus each sibling workbench by name. Hidden entirely when `/scope`
 * reports no parent — a root workbench with no siblings has nothing to
 * switch to.
 */
function InsightsScopeSwitcher({
  scope,
  onSelect,
}: {
  readonly scope: InsightsScope | null;
  readonly onSelect: (tenantId: string | null) => void;
}) {
  if (scope === null || scope.parent === null) return null;
  return (
    <div
      className="insights-scope-switcher"
      role="group"
      aria-label="Insights scope"
    >
      <button
        type="button"
        aria-pressed={true}
        data-active={true}
        className="insights-scope-switcher-option"
        onClick={() => onSelect(null)}
      >
        All workbenches
      </button>
      {scope.workbenches.map((workbench) => (
        <button
          key={workbench.tenantId}
          type="button"
          aria-pressed={false}
          data-active={false}
          className="insights-scope-switcher-option"
          onClick={() => onSelect(workbench.tenantId)}
        >
          {workbench.name}
        </button>
      ))}
    </div>
  );
}

export function InsightsPage({
  path,
  summary,
  activity,
  byTool,
  runs,
  routines,
  workbenches,
  latency,
  range,
  scope,
  resolveWorkbenchIdForTenant,
  scopeLabel,
}: {
  readonly path: string;
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
  readonly runs: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }>;
  readonly routines: APIQuery<readonly Routine[]>;
  /** `/workbenches` — this scope's own row plus one per descendant
   * workbench, used for the "activity by workbench" chart and the
   * "active workbenches" KPI. */
  readonly workbenches: APIQuery<{
    items: readonly WorkbenchUsage[];
  }>;
  /** `/latency` — CL-6257 per-message-run stage p50/p95. */
  readonly latency: APIQuery<LatencySummary>;
  /** Stable 7-day window created once per route mount. */
  readonly range: InsightsRange;
  /** `/scope` result — own identity, parent (if any), sibling
   * workbenches. Null while loading/absent; the switcher hides itself. */
  readonly scope: InsightsScope | null;
  /** A workbench usage row (and the scope switcher's sibling pills) only
   * carry that workbench's tenant id — this resolves it to the workbench
   * that opens `/insights/workbench/:workbenchId` for it (CL-5879), or null
   * when no workbench in view carries that tenancy. */
  readonly resolveWorkbenchIdForTenant: (tenantId: string) => string | null;
  /** "All workbenches" or the current workbench's own name — always known
   * even before `/scope` resolves (falls back to the raw id). */
  readonly scopeLabel: string;
}) {
  const navigate = useNavigate();
  const { mode, runId } = parseInsightsPath(path);
  const { selectedTenantId } = useBench();

  const unauth =
    summary.kind === "unauthenticated" ||
    runs.kind === "unauthenticated" ||
    routines.kind === "unauthenticated";

  if (unauth) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Insights" />
        <PageShell width="full" className="page-fill">
          <SignedOutNotice />
        </PageShell>
      </div>
    );
  }

  const loading =
    summary.kind === "loading" ||
    activity.kind === "loading" ||
    runs.kind === "loading" ||
    routines.kind === "loading";

  // Usage/activity/tools errors must surface. Loading (and ready-empty /
  // no-tenant ready zeros from InsightsRoute) still render zero defaults so
  // the dashboard never invents spend. Runs/routines soft-empty on landing.
  const usageError =
    summary.kind === "error"
      ? summary.message
      : activity.kind === "error"
        ? activity.message
        : byTool.kind === "error"
          ? byTool.message
          : null;

  const summaryData =
    summary.kind === "ready" ? summary.data : EMPTY_OVERALL_USAGE;
  const activityData = activity.kind === "ready" ? activity.data : [];
  const byModelData = summaryData.byModel;
  const byToolData = byTool.kind === "ready" ? byTool.data : [];
  const runsData = runs.kind === "ready" ? runs.data.data : [];
  const runsNextCursor = runs.kind === "ready" ? runs.data.nextCursor : null;
  const routinesData = routines.kind === "ready" ? routines.data : [];
  const workbenchesData =
    workbenches.kind === "ready" ? workbenches.data.items : null;
  const latencyData = latency.kind === "ready" ? latency.data : null;

  if (mode === "run" && runId !== null) {
    const run = runsData.find((r) => r.id === runId) ?? null;
    // Only fetch trace when we have a tenant; unauthenticated already handled.
    return (
      <InsightsRunDetailRoute
        runId={runId}
        run={run}
        tenantId={selectedTenantId}
        onBack={() => navigate("/insights/runs")}
        onOpenRun={(id) => navigate(`/insights/runs/${encodeURIComponent(id)}`)}
      />
    );
  }

  if (mode === "runs") {
    return (
      <InsightsRunsHistory
        runs={runsData}
        loading={runs.kind === "loading"}
        nextCursor={runsNextCursor}
        onOpenRun={(id) => navigate(`/insights/runs/${encodeURIComponent(id)}`)}
        onBack={() => navigate("/insights")}
      />
    );
  }

  if (usageError !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Insights" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="Couldn't load insights"
            description={usageError}
          />
        </PageShell>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title="Insights"
        subtitle={`${scopeLabel} · Last ${INSIGHTS_WINDOW_DAYS} days`}
        actions={
          <InsightsScopeSwitcher
            scope={scope}
            onSelect={(tenantId) => {
              if (tenantId === null) {
                navigate("/insights");
                return;
              }
              const workbenchId = resolveWorkbenchIdForTenant(tenantId);
              if (workbenchId !== null)
                navigate(workbenchInsightsPath(workbenchId));
            }}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <InsightsLanding
            summary={summaryData}
            activity={activityData}
            byModel={byModelData}
            byTool={byToolData}
            runs={runsData}
            routines={routinesData}
            workbenches={workbenchesData}
            latency={latencyData}
            range={range}
            loading={loading}
            onOpenRun={(id) =>
              navigate(`/insights/runs/${encodeURIComponent(id)}`)
            }
            onOpenRuns={() => navigate("/insights/runs")}
            onSelectWorkbench={(tenantId) => {
              const workbenchId = resolveWorkbenchIdForTenant(tenantId);
              if (workbenchId !== null)
                navigate(workbenchInsightsPath(workbenchId));
            }}
          />
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRunDetailRoute({
  runId,
  run,
  tenantId,
  onBack,
  onOpenRun,
}: {
  readonly runId: string;
  readonly run: InsightsRun | null;
  readonly tenantId: string | null;
  readonly onBack: () => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const trace = useAPIQuery(
    tenantId === null ? "" : insightsRunTracePath(tenantId, runId),
    RunTraceSchema,
  );

  // Chain context (CL-5626): resolve the owning task from this run, then
  // its legs, so a run reached from a task/inbox link shows its chain. A
  // run with no owning task 404s the by-run lookup — `shouldRetryQuery`
  // (`../query-client.ts`) never retries a 404, so that's a stable, cheap
  // answer, not a transient failure: task stays null, the legs query never
  // enables, and this quietly renders the plain single-run view for what is
  // simply "not a chained run." Any OTHER failure (500, network) is a real
  // problem and must say so, not disappear the same way — see
  // `chainLookupFailed` below.
  const taskByRun = useAPIQuery(
    tenantId === null ? "" : insightsTaskByRunPath(tenantId, runId),
    TaskResponseSchema,
  );
  const task = taskByRun.kind === "ready" ? taskByRun.data.item : null;
  const chainLookupFailed =
    taskByRun.kind === "error" && taskByRun.status !== 404;
  const legsQuery = useAPIQuery(
    tenantId === null || task === null || task.stepCount <= 1
      ? ""
      : insightsTaskLegsPath(tenantId, task.id),
    TaskLegsResponseSchema,
  );
  const chainLegs = legsQuery.kind === "ready" ? legsQuery.data.items : null;

  return (
    <InsightsRunDetail
      runId={runId}
      run={run}
      trace={trace}
      chainLegs={chainLegs}
      chainLookupFailed={chainLookupFailed}
      onOpenRun={onOpenRun}
      onBack={onBack}
    />
  );
}

/**
 * Insights scoped to one workbench (CL-5879) — `/insights/workbench/:workbenchId`
 * resolves the workbench's own workbench tenant (see
 * `../insights-workbench-scope.ts`) and titles the page by the WORKBENCH name,
 * never the tenant's. A true legacy workbench (tenancy `null`) and an id
 * absent from the bench's own workbench list (a stale
 * `/insights/workbench/:tenantId` link, or any other mis-wired id — that
 * route is retired) both get an honest empty state instead of a doomed
 * tenant-scoped fetch.
 */
function InsightsWorkbenchPage({
  workbenchId,
  workbenchesLoading,
  resolution,
  benchTenantId,
  onOpenRun,
}: {
  readonly workbenchId: string;
  readonly workbenchesLoading: boolean;
  readonly resolution: WorkbenchInsightsResolution;
  readonly benchTenantId: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  if (workbenchesLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Insights" />
        <PageShell width="full" className="page-fill">
          <Skeleton className="h-48 w-full" />
        </PageShell>
      </div>
    );
  }
  if (resolution.kind === "not-found") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Insights" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="Workbench not found"
            description="This conversation may have been deleted, or you may not have access to it."
          />
        </PageShell>
      </div>
    );
  }
  if (resolution.kind === "legacy") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Insights" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="No insights for this conversation yet"
            description="This conversation predates per-workbench insights."
          />
        </PageShell>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={resolution.title}
        subtitle={`Last ${INSIGHTS_WINDOW_DAYS} days`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <WorkbenchTimelineRoute
            benchTenantId={benchTenantId}
            workbenchId={workbenchId}
            onOpenRun={onOpenRun}
          />
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRoute({ path }: { readonly path?: string }) {
  const { selectedTenantId } = useBench();
  const navigate = useNavigate();
  const currentPath =
    path ??
    (typeof window !== "undefined" ? window.location.pathname : "/insights");
  const { mode, workbenchId } = parseInsightsPath(currentPath);

  // A sliding window: `to` re-anchors to now every minute, so the
  // dashboard keeps up with live turns instead of freezing at whatever
  // instant the page mounted. The minute granularity keeps query keys
  // stable between ticks.
  const range = useInsightsWindow();

  // Own identity, parent (a workspace, if this workbench has one), and
  // sibling workbenches — read once off the current workbench regardless
  // of scope, since it describes the switcher options, not the data
  // itself. See @corbits/insights' routes.ts `/scope`.
  const scope = useAPIQuery(
    selectedTenantId === null ? "" : insightsScopePath(selectedTenantId),
    InsightsScopeSchema,
  );
  const scopeData = scope.kind === "ready" ? scope.data : null;

  // The bench's own workbench list, shared with `ChatWorkspace`'s sidebar via
  // `workbenchesQueryKey` (never a bespoke fetch of its own) — the single
  // mechanism behind both directions of workbench↔workbench-tenant
  // resolution (CL-5879): a `/insights/workbench/:workbenchId` deep link
  // resolving its own tenant below, and a usage row's tenant id resolving
  // back to the workbench that opens it (`resolveWorkbenchIdForTenant`, fed to
  // `InsightsPage` for the "activity by workbench" rows and the scope
  // switcher's sibling pills).
  const workbenchesOfKind = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "workbenches", "workbench"]
      : workbenchesQueryKey(selectedTenantId, "workbench"),
    selectedTenantId !== null,
    () => listWorkbenches(selectedTenantId as string, "workbench"),
  );
  const chatsOfKind = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "workbenches", "chat"]
      : workbenchesQueryKey(selectedTenantId, "chat"),
    selectedTenantId !== null,
    () => listWorkbenches(selectedTenantId as string, "chat"),
  );
  const workbenchesLoading =
    workbenchesOfKind.kind === "loading" || chatsOfKind.kind === "loading";
  const allWorkbenches: readonly Workbench[] = [
    ...(workbenchesOfKind.kind === "ready" ? workbenchesOfKind.data : []),
    ...(chatsOfKind.kind === "ready" ? chatsOfKind.data : []),
  ];
  const resolveWorkbenchIdForTenant = (tenantId: string): string | null =>
    workbenchIdForWorkbenchTenant(allWorkbenches, tenantId);
  const workbenchResolution: WorkbenchInsightsResolution | null =
    mode === "workbench" && workbenchId !== null
      ? resolveWorkbenchInsightsScope(allWorkbenches, workbenchId)
      : null;

  const { effectiveTenantId, scopeLabel } = resolveInsightsScope({
    mode,
    selectedTenantId,
    scopeData,
  });

  const summary = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsUsagePath(effectiveTenantId, range),
    OverallUsageSchema,
  );
  const activityRaw = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsActivityPath(effectiveTenantId, range),
    ActivityResponseSchema,
  );
  const toolsRaw = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsToolsPath(effectiveTenantId, range),
    ToolsResponseSchema,
  );
  const runs = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsTopLevelRunsPath(effectiveTenantId),
    TopLevelRunsSchema,
  );
  // Only meaningful on the cross-workbench landing — mode "workbench" renders
  // `InsightsWorkbenchPage` instead of `InsightsPage`, so there is nothing
  // here to chart and the fetch stays disabled.
  const workbenches = useAPIQuery(
    effectiveTenantId === null || mode !== "landing"
      ? ""
      : insightsWorkbenchesPath(effectiveTenantId, range),
    WorkbenchesResponseSchema,
  );
  // CL-6257 turn-latency tiles: same landing-only scope as `workbenches`
  // above (the per-workbench route renders `InsightsWorkbenchPage`'s
  // timeline instead of this landing, so there is nothing here to show).
  const latency = useAPIQuery(
    effectiveTenantId === null || mode !== "landing"
      ? ""
      : insightsLatencyPath(effectiveTenantId, range),
    LatencySummarySchema,
  );
  const routines = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "routines"]
      : tenantKeys.routines(selectedTenantId),
    selectedTenantId !== null,
    () => listRoutines(selectedTenantId as string),
  );

  const routinesForPage: APIQuery<readonly Routine[]> =
    selectedTenantId === null ? { kind: "ready", data: [] } : routines;

  // Unwrap package envelopes ({ days }, { tools }) for the page surface.
  const activity: APIQuery<readonly DayActivity[]> =
    activityRaw.kind === "ready"
      ? { kind: "ready", data: activityRaw.data.days }
      : activityRaw;
  const byTool: APIQuery<readonly ToolCall[]> =
    toolsRaw.kind === "ready"
      ? { kind: "ready", data: toolsRaw.data.tools }
      : toolsRaw;

  // No tenant in scope: zero usage/run defaults so the page shows an
  // honest empty state without inventing nonzero workbench usage or runs.
  const emptySummary: APIQuery<OverallUsage> =
    effectiveTenantId === null
      ? { kind: "ready", data: EMPTY_OVERALL_USAGE }
      : summary;
  const emptyList = <T,>(q: APIQuery<T>): APIQuery<T> =>
    effectiveTenantId === null
      ? ({ kind: "ready", data: [] as unknown as T } as APIQuery<T>)
      : q;
  const runsForPage: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }> =
    effectiveTenantId === null
      ? { kind: "ready", data: { data: [], nextCursor: null } }
      : runs;

  if (
    mode === "workbench" &&
    workbenchId !== null &&
    workbenchResolution !== null
  ) {
    return (
      <InsightsWorkbenchPage
        workbenchId={workbenchId}
        workbenchesLoading={workbenchesLoading}
        resolution={workbenchResolution}
        benchTenantId={selectedTenantId}
        onOpenRun={(id) => navigate(`/insights/runs/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <InsightsPage
      path={currentPath}
      summary={emptySummary}
      activity={emptyList(activity)}
      byTool={emptyList(byTool)}
      runs={runsForPage}
      routines={routinesForPage}
      workbenches={workbenches}
      latency={latency}
      range={range}
      scope={scopeData}
      resolveWorkbenchIdForTenant={resolveWorkbenchIdForTenant}
      scopeLabel={scopeLabel}
    />
  );
}
