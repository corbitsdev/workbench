// Insights over packages/insights: cost KPIs, activity bars, token mosaic,
// cost-by-model, calls-by-tool, recent purpose runs, runs history, and
// run-trace detail. Absent usage is zero metrics + zero day series
// (EMPTY_OVERALL_USAGE / activitySeriesForWindow). Null cost/rate still
// means "rate unknown" when turns exist — em-dash, not a fabricated cost.
// Stage layout mirrors the shell mock: KPI row → chart/card grid → recent runs.

import {
  Badge,
  PageShell,
  RichEmptyState,
  Skeleton,
  TokenMosaic,
  TraceWaterfall,
  type TraceSpan,
} from "@corbits/react-ui";
import { ChartColumn } from "lucide-react";
import { useMemo } from "react";

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
  type DayActivity,
  type InsightsRange,
  type ModelUsage,
  type OverallUsage,
} from "@corbits/insights/client";

import { SignedOutNotice, type APIQuery } from "@corbits/api-query";

import { RunsSchema, useAPIQuery, type WorkflowRun } from "../api";
import { useBench } from "../bench-context";
import {
  ActivityResponseSchema,
  OverallUsageSchema,
  RunTraceSchema,
  ToolsResponseSchema,
  insightsActivityPath,
  insightsRunTracePath,
  insightsToolsPath,
  insightsUsagePath,
  type RunTrace,
  type ToolCall,
} from "../insights-api";
import {
  computeInsightsStats,
  computeTraceStats,
  filterRunsByCreatedAt,
  purposeRunsForInsights,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { tenantKeys } from "../query-client";
import { StageCrumbs, StageTopBar } from "../shell/stage-top-bar";
import { listRoutines, useTenantQuery, type Routine } from "../routines-api";

function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(
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
  if (loading) return "…";
  if (value === null) return "—";
  return String(value);
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

function toTraceSpans(trace: RunTrace): TraceSpan[] {
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
  const body = (
    <>
      <div className="insights-stat-k">{label}</div>
      <div className="insights-stat-v">{loading ? "…" : value}</div>
      {detail !== undefined ? (
        <div className="insights-stat-d">{loading ? " " : detail}</div>
      ) : null}
    </>
  );
  if (onClick !== undefined) {
    return (
      <button type="button" className="insights-stat" onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className="insights-stat">{body}</div>;
}

function ActivityBars({ days }: { readonly days: readonly DayActivity[] }) {
  const window = recentActivityDays(days);
  const max = Math.max(1, ...window.map((d) => d.turns));
  return (
    <div className="insights-gen-bars" role="img" aria-label="Daily turns">
      {window.map((d) => {
        const pct = Math.round((d.turns / max) * 100);
        return (
          <div key={d.day} className="insights-gen-bar-row">
            <span title={d.day}>{dayWeekdayLabel(d.day)}</span>
            <div className="insights-gen-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <span>{formatCount(d.turns)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ModelCostTable({
  models,
}: {
  readonly models: readonly ModelUsage[];
}) {
  return (
    <div className="insights-table-wrap">
      <table className="insights-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Cost</th>
            <th>Input</th>
            <th>Cache read</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model}>
              <td title={m.model}>{m.model}</td>
              <td>
                {m.costUsd === null && m.tokens.total > 0
                  ? "—"
                  : formatUsd(m.costUsd)}
              </td>
              <td>{formatCount(m.tokens.input)}</td>
              <td>{formatCount(m.tokens.cacheRead)}</td>
              <td>{formatCount(m.tokens.output)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolCallsTable({ tools }: { readonly tools: readonly ToolCall[] }) {
  return (
    <div className="insights-table-wrap">
      <table className="insights-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Error rate</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.tool}>
              <td title={t.tool}>{t.tool}</td>
              <td>{formatCount(t.calls)}</td>
              <td>{formatCount(t.errors)}</td>
              <td>{formatRate(t.errorRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentRunRows({
  runs,
  onOpenRun,
  onOpenRuns,
}: {
  readonly runs: readonly WorkflowRun[];
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
}) {
  return (
    <div className="insights-run-list">
      {runs.map((row) => (
        <button
          key={row.id}
          type="button"
          className="insights-run-row"
          data-ctx-insights-run={row.id}
          onClick={() => onOpenRun(row.id)}
        >
          <span className="insights-run-meta">
            <strong>{row.definitionName}</strong>
            <span>
              {formatWhen(row.createdAt)} · {row.tenantName}
            </span>
          </span>
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        </button>
      ))}
      <button
        type="button"
        className="insights-run-row insights-run-row-more"
        onClick={onOpenRuns}
      >
        <span className="insights-run-meta">
          <strong>All runs & traces →</strong>
        </span>
      </button>
    </div>
  );
}

function InsightsLanding({
  summary,
  activity,
  byModel,
  byTool,
  runs,
  routines,
  range,
  loading,
  onOpenRun,
  onOpenRuns,
}: {
  readonly summary: OverallUsage | null;
  readonly activity: readonly DayActivity[] | null;
  readonly byModel: readonly ModelUsage[] | null;
  readonly byTool: readonly ToolCall[] | null;
  readonly runs: readonly WorkflowRun[];
  readonly routines: readonly Routine[];
  /** Same 7-day window as usage/activity/tools requests. */
  readonly range: InsightsRange;
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
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

  return (
    <div className="insights-layout">
      <div className="insights-stat-row">
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
          label="Runs"
          value={tileValue(formatCount(stats.totalRuns), loading)}
          detail={runsDetailLabel(stats)}
          onClick={onOpenRuns}
          loading={loading}
        />
        {stats.running > 0 || loading ? (
          <InsightsStat
            label="Running now"
            value={tileValue(formatCount(stats.running), loading)}
            detail="in flight"
            loading={loading}
          />
        ) : null}
      </div>

      {missingRates.length > 0 ? (
        <p className="insights-note">
          Rates unknown for: {missingRates.join(", ")}. Those turns do not
          contribute a fabricated cost.
        </p>
      ) : null}

      <div className="insights-grid">
        <section className="insights-panel">
          <h3>Activity · last {activityDays.length} days</h3>
          <ActivityBars days={activityDays} />
        </section>

        {mosaicParts.length > 0 ? (
          <section className="insights-panel">
            <h3>Token mix</h3>
            <TokenMosaic parts={mosaicParts} label="Token usage by class" />
            <div className="insights-stat-row insights-stat-row-nested">
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
            </div>
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

function InsightsRunsHistory({
  runs,
  loading,
  onOpenRun,
  onBack,
}: {
  readonly runs: readonly WorkflowRun[];
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onBack: () => void;
}) {
  const purpose = purposeRunsForInsights(runs);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={
          <StageCrumbs
            crumbs={[
              { label: "Insights", onSelect: onBack },
              { label: "Runs" },
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
            ) : purpose.length === 0 ? (
              <RichEmptyState
                icon={<ChartColumn />}
                title="No purpose runs yet"
                description="When a routine or purpose workflow fires, it shows up here."
              />
            ) : (
              <div className="insights-run-list">
                {purpose.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="insights-run-row"
                    data-ctx-insights-run={row.id}
                    onClick={() => onOpenRun(row.id)}
                  >
                    <span className="insights-run-meta">
                      <strong>{row.definitionName}</strong>
                      <span>
                        {formatWhen(row.createdAt)} · {row.tenantName}
                      </span>
                    </span>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRunDetail({
  runId,
  run,
  trace,
  onBack,
}: {
  readonly runId: string;
  readonly run: WorkflowRun | null;
  readonly trace: APIQuery<RunTrace>;
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
              { label: run?.definitionName ?? runId },
            ]}
          />
        }
        subtitle={run !== null ? formatWhen(run.createdAt) : null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            <div className="insights-stat-row">
              {/* Owner is not carried by WorkflowRunSummary yet — dash, not
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
            </div>

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
            {trace.kind === "ready" &&
            "absent" in trace.data &&
            trace.data.spans === null ? (
              <RichEmptyState
                title="Trace reader not mounted"
                description="Trace detail isn't available yet. Spans stay absent — not shown as zeros."
              />
            ) : null}
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
            {trace.kind === "ready" &&
            spans.length === 0 &&
            !("absent" in trace.data) ? (
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

function parseInsightsPath(path: string): {
  mode: "landing" | "runs" | "run";
  runId: string | null;
} {
  if (path === "/insights" || path === "/insights/") {
    return { mode: "landing", runId: null };
  }
  if (path === "/insights/runs" || path === "/insights/runs/") {
    return { mode: "runs", runId: null };
  }
  const match = /^\/insights\/runs\/([^/]+)\/?$/.exec(path);
  if (match !== null && match[1] !== undefined) {
    return { mode: "run", runId: decodeURIComponent(match[1]) };
  }
  return { mode: "landing", runId: null };
}

export function InsightsPage({
  path,
  summary,
  activity,
  byTool,
  runs,
  routines,
  range,
}: {
  readonly path: string;
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
  readonly runs: APIQuery<{ data: readonly WorkflowRun[] }>;
  readonly routines: APIQuery<readonly Routine[]>;
  /** Stable 7-day window created once per route mount. */
  readonly range: InsightsRange;
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
      <PageShell width="full" className="page-fill">
        <SignedOutNotice />
      </PageShell>
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
  const routinesData = routines.kind === "ready" ? routines.data : [];

  if (mode === "run" && runId !== null) {
    const run = runsData.find((r) => r.id === runId) ?? null;
    // Only fetch trace when we have a tenant; unauthenticated already handled.
    return (
      <InsightsRunDetailRoute
        runId={runId}
        run={run}
        tenantId={selectedTenantId}
        onBack={() => navigate("/insights/runs")}
      />
    );
  }

  if (mode === "runs") {
    return (
      <InsightsRunsHistory
        runs={runsData}
        loading={runs.kind === "loading"}
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
            icon={<ChartColumn />}
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
        subtitle={`Last ${INSIGHTS_WINDOW_DAYS} days`}
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
            range={range}
            loading={loading}
            onOpenRun={(id) =>
              navigate(`/insights/runs/${encodeURIComponent(id)}`)
            }
            onOpenRuns={() => navigate("/insights/runs")}
          />
        </PageShell>
      </div>
    </div>
  );
}

function InsightsRunDetailRoute({
  runId,
  run,
  tenantId,
  onBack,
}: {
  readonly runId: string;
  readonly run: WorkflowRun | null;
  readonly tenantId: string | null;
  readonly onBack: () => void;
}) {
  const trace = useAPIQuery(
    tenantId === null ? "" : insightsRunTracePath(tenantId, runId),
    RunTraceSchema,
  );
  return (
    <InsightsRunDetail runId={runId} run={run} trace={trace} onBack={onBack} />
  );
}

export function InsightsRoute({ path }: { readonly path?: string }) {
  const { selectedTenantId } = useBench();
  const currentPath =
    path ??
    (typeof window !== "undefined" ? window.location.pathname : "/insights");

  // One window per mount — shared by usage/activity/tools query keys and
  // the landing run KPI/recent filter so labels stay honest and stable.
  const range = useMemo(() => createInsightsWindow(), []);

  const summary = useAPIQuery(
    selectedTenantId === null ? "" : insightsUsagePath(selectedTenantId, range),
    OverallUsageSchema,
  );
  const activityRaw = useAPIQuery(
    selectedTenantId === null
      ? ""
      : insightsActivityPath(selectedTenantId, range),
    ActivityResponseSchema,
  );
  const toolsRaw = useAPIQuery(
    selectedTenantId === null ? "" : insightsToolsPath(selectedTenantId, range),
    ToolsResponseSchema,
  );
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
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

  // No tenant: zero usage defaults so the page can still show me-scoped
  // purpose runs without inventing nonzero bench usage.
  const emptySummary: APIQuery<OverallUsage> =
    selectedTenantId === null
      ? { kind: "ready", data: EMPTY_OVERALL_USAGE }
      : summary;
  const emptyList = <T,>(q: APIQuery<T>): APIQuery<T> =>
    selectedTenantId === null
      ? ({ kind: "ready", data: [] as unknown as T } as APIQuery<T>)
      : q;

  return (
    <InsightsPage
      path={currentPath}
      summary={emptySummary}
      activity={emptyList(activity)}
      byTool={emptyList(byTool)}
      runs={runs}
      routines={routinesForPage}
      range={range}
    />
  );
}
