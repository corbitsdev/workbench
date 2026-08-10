// Insights over packages/insights: cost KPIs, activity bars, token mosaic,
// cost-by-model, calls-by-tool, recent purpose runs, runs history, and
// run-trace detail. Null costs and rates render as em-dash — never zero.

import {
  Badge,
  CategoryBars,
  PageShell,
  RichEmptyState,
  Section,
  Skeleton,
  StatGrid,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TokenMosaic,
  TraceWaterfall,
  type TraceSpan,
} from "@corbits/react-ui";
import { ChartColumn } from "lucide-react";

import {
  RunsSchema,
  useAPIQuery,
  type APIQuery,
  type WorkflowRun,
} from "../api";
import { useBench } from "../bench-context";
import {
  durationLabel,
  formatCount,
  formatRate,
  formatUsd,
  insightsActivityPath,
  insightsByModelPath,
  insightsByToolPath,
  insightsRunTracePath,
  insightsSummaryPath,
  tokensLabel,
  DayActivitySchema,
  ModelUsageSchema,
  OverallUsageSchema,
  RunTraceSchema,
  ToolCallSchema,
  type DayActivity,
  type ModelUsage,
  type OverallUsage,
  type RunTrace,
  type ToolCall,
} from "../insights-api";
import {
  computeInsightsStats,
  purposeRunsForInsights,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { SignedOutNotice } from "../query-view";
import { tenantKeys } from "../query-client";
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
      return "success";
    case "running":
    case "pending":
    case "awaiting":
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

function activityBarsData(days: readonly DayActivity[]) {
  return days.map((d) => {
    const secondary = d.costUsd === null ? undefined : formatUsd(d.costUsd);
    return secondary === undefined
      ? { label: d.day.slice(5), value: d.turns }
      : {
          label: d.day.slice(5),
          value: d.turns,
          secondaryLabel: secondary,
        };
  });
}

function modelBarsData(models: readonly ModelUsage[]) {
  return models.map((m) => {
    const secondary = m.ratesKnown ? formatUsd(m.costUsd) : "rates unknown";
    return {
      label: m.model,
      value: m.tokens.total,
      secondaryLabel: secondary,
    };
  });
}

function toolBarsData(tools: readonly ToolCall[]) {
  return tools.map((t) => {
    const secondary =
      t.successRate === null ? undefined : `${formatRate(t.successRate)} ok`;
    return secondary === undefined
      ? { label: t.tool, value: t.calls }
      : { label: t.tool, value: t.calls, secondaryLabel: secondary };
  });
}

function tokenParts(summary: OverallUsage) {
  const t = summary.totalTokens;
  return [
    { label: "Input", value: t.input },
    { label: "Output", value: t.output },
    { label: "Cache read", value: t.cacheRead },
    { label: "Cache write", value: t.cacheWrite },
    { label: "Thinking", value: t.thinking },
  ].filter((p) => p.value > 0);
}

function toTraceSpans(trace: RunTrace): TraceSpan[] {
  const origin = Math.min(...trace.spans.map((s) => s.startMs), 0);
  const end = Math.max(...trace.spans.map((s) => s.endMs), origin + 1);
  const span = Math.max(1, end - origin);
  return trace.spans.map((s) => {
    const base = {
      id: s.id,
      label: s.label,
      kind: s.kind,
      start: (s.startMs - origin) / span,
      end: (s.endMs - origin) / span,
      durationLabel: durationLabel(s.endMs - s.startMs),
      phase: s.phase,
    };
    const tok = tokensLabel(s.tokens);
    if (s.error !== undefined && tok !== undefined) {
      return { ...base, tokensLabel: tok, error: s.error };
    }
    if (s.error !== undefined) return { ...base, error: s.error };
    if (tok !== undefined) return { ...base, tokensLabel: tok };
    return base;
  });
}

function cacheHitRate(summary: OverallUsage): number | null {
  const t = summary.totalTokens;
  const denom = t.input + t.cacheRead;
  if (denom === 0) return null;
  return t.cacheRead / denom;
}

function InsightsLanding({
  summary,
  activity,
  byModel,
  byTool,
  runs,
  routines,
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
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
}) {
  const stats = computeInsightsStats(runs, routines);
  const purposeRuns = purposeRunsForInsights(runs);
  const empty =
    !loading &&
    (summary === null || summary.turnCount === 0) &&
    stats.totalRuns === 0;

  if (empty) {
    return (
      <RichEmptyState
        icon={<ChartColumn />}
        title="Nothing to chart yet"
        description="Usage and purpose runs land here once agents start turning. Cost and token numbers stay blank until the sink has data — never fake zeros."
        actions={[
          { label: "Open Routines", href: "/routines", variant: "primary" },
        ]}
      />
    );
  }

  const mosaicParts = summary === null ? [] : tokenParts(summary);
  const hitRate = summary === null ? null : cacheHitRate(summary);

  return (
    <>
      <Section
        title="Cost & activity"
        description="Live usage for this bench. Missing rates show as —."
      >
        <StatGrid>
          <StatTile
            label="Total cost"
            value={tileValue(
              summary === null ? null : formatUsd(summary.totalCostUsd),
              loading,
            )}
          />
          <StatTile
            label="Total tokens"
            value={tileValue(
              summary === null ? null : formatCount(summary.totalTokens.total),
              loading,
            )}
          />
          <StatTile
            label="Turns"
            value={tileValue(
              summary === null ? null : formatCount(summary.turnCount),
              loading,
            )}
          />
          <StatTile
            label="Purpose runs"
            value={tileValue(formatCount(stats.totalRuns), loading)}
          />
        </StatGrid>
        {summary !== null && summary.modelsWithMissingRates.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Rates unknown for: {summary.modelsWithMissingRates.join(", ")}.
            Those turns do not contribute a fabricated cost.
          </p>
        ) : null}
      </Section>

      {activity !== null && activity.length > 0 ? (
        <Section title="Activity" description="Turns per UTC day.">
          <CategoryBars
            title="Daily turns"
            data={activityBarsData(activity)}
            valueLabel="Turns"
          />
        </Section>
      ) : null}

      {summary !== null && mosaicParts.length > 0 ? (
        <Section
          title="Token mix"
          description="Share of tokens by class for recorded turns."
        >
          <div className="grid gap-4 md:grid-cols-[1fr_auto_auto]">
            <TokenMosaic parts={mosaicParts} label="Token usage by class" />
            <StatTile
              label="Cache hit rate"
              value={tileValue(formatRate(hitRate), false)}
            />
            <StatTile
              label="Running now"
              value={tileValue(formatCount(stats.running), false)}
            />
          </div>
        </Section>
      ) : null}

      {byModel !== null && byModel.length > 0 ? (
        <Section title="Cost by model" description="Tokens and cost per model.">
          <CategoryBars
            title="Models"
            data={modelBarsData(byModel)}
            valueLabel="Tokens"
            format={(n) => formatCount(n)}
          />
        </Section>
      ) : null}

      {byTool !== null && byTool.length > 0 ? (
        <Section
          title="Calls by tool"
          description="Tool invocations on this bench."
        >
          <CategoryBars
            title="Tools"
            data={toolBarsData(byTool)}
            valueLabel="Calls"
          />
        </Section>
      ) : null}

      {purposeRuns.length > 0 ? (
        <Section
          title="Recent runs"
          description="Newest purpose workflow runs first. Open a row for the trace when one is available."
        >
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              className="text-sm text-primary underline-offset-2 hover:underline"
              onClick={onOpenRuns}
            >
              All runs
            </button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bench</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purposeRuns.slice(0, 12).map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left text-primary underline-offset-2 hover:underline"
                      onClick={() => onOpenRun(row.id)}
                    >
                      {row.definitionName}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </TableCell>
                  <TableCell>{row.tenantName}</TableCell>
                  <TableCell>{formatWhen(row.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
    </>
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
    <PageShell width="full" className="page-fill">
      <Section
        title="Runs"
        description={
          <>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={onBack}
            >
              Insights
            </button>
            {" / Runs history"}
          </>
        }
      >
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : purpose.length === 0 ? (
          <RichEmptyState
            icon={<ChartColumn />}
            title="No purpose runs yet"
            description="When a routine or purpose workflow fires, it shows up here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bench</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purpose.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left text-primary underline-offset-2 hover:underline"
                      onClick={() => onOpenRun(row.id)}
                    >
                      {row.definitionName}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </TableCell>
                  <TableCell>{row.tenantName}</TableCell>
                  <TableCell>{formatWhen(row.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </PageShell>
  );
}

function InsightsRunDetail({
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

  return (
    <PageShell width="full" className="page-fill">
      <Section
        title={run?.definitionName ?? runId}
        description={
          <>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={onBack}
            >
              Runs
            </button>
            {` / ${runId}`}
          </>
        }
      >
        <StatGrid>
          <StatTile
            label="Status"
            value={dash(
              run?.status ??
                (trace.kind === "ready" ? trace.data.status : null),
            )}
          />
          <StatTile
            label="Started"
            value={dash(
              run !== null
                ? formatWhen(run.createdAt)
                : trace.kind === "ready"
                  ? formatWhen(trace.data.startedAt)
                  : null,
            )}
          />
          <StatTile
            label="Cost"
            value={
              trace.kind === "ready" ? formatUsd(trace.data.totalCostUsd) : "—"
            }
          />
          <StatTile
            label="Tokens"
            value={
              trace.kind === "ready" && trace.data.totalTokens !== null
                ? formatCount(trace.data.totalTokens.total)
                : "—"
            }
          />
        </StatGrid>
      </Section>

      {trace.kind === "loading" ? <Skeleton className="h-48 w-full" /> : null}
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
        <Section title="Trace" description="Span timeline for this run.">
          <TraceWaterfall
            title="Run trace"
            spans={spans}
            description={`${spans.length} span${spans.length === 1 ? "" : "s"}`}
          />
        </Section>
      ) : null}
      {trace.kind === "ready" && spans.length === 0 ? (
        <RichEmptyState
          title="Empty trace"
          description="The run exists but has no recorded spans yet."
        />
      ) : null}
    </PageShell>
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
  byModel,
  byTool,
  runs,
  routines,
}: {
  readonly path: string;
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byModel: APIQuery<readonly ModelUsage[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
  readonly runs: APIQuery<{ data: readonly WorkflowRun[] }>;
  readonly routines: APIQuery<readonly Routine[]>;
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
    byModel.kind === "loading" ||
    runs.kind === "loading" ||
    routines.kind === "loading";

  const failed =
    summary.kind === "error"
      ? summary.message
      : activity.kind === "error"
        ? activity.message
        : byModel.kind === "error"
          ? byModel.message
          : runs.kind === "error"
            ? runs.message
            : routines.kind === "error"
              ? routines.message
              : null;

  // Soft-fail usage endpoints (e.g. pre-mount / empty sink) — still show runs.
  const summaryData = summary.kind === "ready" ? summary.data : null;
  const activityData = activity.kind === "ready" ? activity.data : null;
  const byModelData = byModel.kind === "ready" ? byModel.data : null;
  const byToolData = byTool.kind === "ready" ? byTool.data : null;
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

  if (failed !== null && summary.kind === "error" && runs.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<ChartColumn />}
          title="Couldn't load insights"
          description={failed}
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="full" className="page-fill">
      <Section
        title="Insights"
        description="Usage, cost, and purpose-run activity for this bench."
      >
        <InsightsLanding
          summary={summaryData}
          activity={activityData}
          byModel={byModelData}
          byTool={byToolData}
          runs={runsData}
          routines={routinesData}
          loading={loading}
          onOpenRun={(id) =>
            navigate(`/insights/runs/${encodeURIComponent(id)}`)
          }
          onOpenRuns={() => navigate("/insights/runs")}
        />
      </Section>
    </PageShell>
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

  const summary = useAPIQuery(
    selectedTenantId === null ? "" : insightsSummaryPath(selectedTenantId),
    OverallUsageSchema,
  );
  const activity = useAPIQuery(
    selectedTenantId === null ? "" : insightsActivityPath(selectedTenantId, 14),
    DayActivitySchema.array(),
  );
  const byModel = useAPIQuery(
    selectedTenantId === null ? "" : insightsByModelPath(selectedTenantId),
    ModelUsageSchema.array(),
  );
  const byTool = useAPIQuery(
    selectedTenantId === null ? "" : insightsByToolPath(selectedTenantId),
    ToolCallSchema.array(),
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

  // No tenant: usage endpoints stay empty-ready so the page can still show
  // me-scoped purpose runs without inventing bench usage.
  const emptySummary: APIQuery<OverallUsage> =
    selectedTenantId === null
      ? {
          kind: "ready",
          data: {
            totalCostUsd: null,
            totalTokens: {
              input: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              thinking: 0,
              total: 0,
            },
            turnCount: 0,
            modelsWithMissingRates: [],
          },
        }
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
      byModel={emptyList(byModel)}
      byTool={emptyList(byTool)}
      runs={runs}
      routines={routinesForPage}
    />
  );
}
