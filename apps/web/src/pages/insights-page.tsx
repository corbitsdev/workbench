// Insights over the native `GET /workflows/runs` top-level listing: KPI
// row, "running now" strip, recent purpose runs, and runs history grouped
// by definition. The stock observability routes
// (`vendor/intx/hub-api/src/routes/observability.ts`'s four GET routes)
// are unimplemented stubs — each returns 501 — so this page is entirely
// native `WorkflowRunResponse` data, already fetched the same way
// `mission-control-page.tsx` and `routines-api.ts` read runs elsewhere in
// this app.

import {
  Badge,
  PageShell,
  RichEmptyState,
  RUN_STATUS_DOT_TONE,
  RUN_STATUS_TONE,
  Skeleton,
  StatGrid,
  StatGridItem,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
  type RunStatus,
} from "@corbits/react-ui";
import { ChartBar } from "@corbits/icons";
import { runOutcomeStatus, runStatusLabel, withListingAbandoned } from "@corbits/workflows/client";
import type * as React from "react";
import { useEffect, useState } from "react";

import { workflowRunStatuses, type WorkflowRunStatus } from "@intx/types";
import { SignedOutNotice, type APIQuery } from "@corbits/api-query";
import { workbenchesQueryKey, listWorkbenches } from "@corbits/chat-ui";

import { useBench } from "../bench-context";
import { resolveWorkbenchInsightsScope } from "../insights-workbench-scope";
import { parseInsightsPath } from "../insights-path";
import { insightsTopLevelRunsPath, TopLevelRunsSchema, type InsightsRun } from "../insights-api";
import {
  computeInsightsStats,
  durationLabel,
  formatCount,
  groupRunsByDefinition,
  purposeRunsForInsights,
  runDisplayName,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { tenantKeys } from "../query-client";
import { useAPIQuery } from "../api";
import { INSIGHTS_PATH_PREFIX, INSIGHTS_RUNS_PATH } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  listScheduledWorkflows,
  useTenantQuery,
  type ScheduledWorkflowDefinition,
} from "../routines-api";
import { WorkbenchTimelineRoute } from "./workbench-timeline";

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

/** A platform workflow run's status (`WorkflowRunStatus`) doesn't spell
 * react-ui's `RunStatus` vocabulary the same way — normalize onto it here
 * so the badge tone always comes from `RUN_STATUS_TONE`, the one source
 * every run-status tone reads from, rather than a second opinion invented
 * on this page. */
const WORKFLOW_RUN_STATUS_ALIAS: Readonly<Record<WorkflowRunStatus, RunStatus>> = {
  deployed: "completed",
  running: "running",
  updating: "running",
  error: "failed",
  stopped: "stopped",
};

export function statusTone(status: WorkflowRunStatus): BadgeTone {
  return RUN_STATUS_TONE[WORKFLOW_RUN_STATUS_ALIAS[status]];
}

function isWorkflowRunStatus(status: string): status is WorkflowRunStatus {
  return workflowRunStatuses.some((value) => value === status);
}

function insightsStatusTone(status: string): BadgeTone {
  if (status === "completed") return RUN_STATUS_TONE.completed;
  if (status === "failed") return RUN_STATUS_TONE.failed;
  if (status === "cancelled") return RUN_STATUS_TONE.stopped;
  if (isWorkflowRunStatus(status)) return statusTone(status);
  return "neutral";
}

function tileValue(value: string | number | null, loading: boolean): string {
  if (loading) return "";
  if (value === null) return "—";
  return String(value);
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

function runsDetailLabel(stats: { readonly running: number; readonly errored: number }): string {
  if (stats.running > 0) {
    return `${formatCount(stats.running)} running`;
  }
  if (stats.errored > 0) {
    return `${formatCount(stats.errored)} errored`;
  }
  return "runs";
}

const ELAPSED_TICK_MS = 1_000;

/** Ticks once a second while `enabled` — the clock the elapsed label next to
 * the pulsing `StatusDot` reads from, so it counts up like the live indicator
 * beside it instead of freezing at whatever instant this component mounted
 * or last re-rendered for an unrelated reason. */
function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** A run actually in flight right now (`status: running | updating`) —
 * liveness is not a windowed property, so this filters the full run set,
 * never the range-filtered one. A persisted `endedAt` means the fire
 * already finished, even if `status` still reads `running`. A live fire
 * with an in-flight turn stays in flight however old it is; without an
 * explicit no-in-flight signal, missing `turns` is not abandonment.
 */
export function isRunningNow(run: InsightsRun, now: number = Date.now()): boolean {
  const outcome = runOutcomeStatus(withListingAbandoned(run, now), now);
  return outcome === "running" || outcome === "updating";
}

function insightsRunStatus(run: InsightsRun, now: number = Date.now()): string {
  return runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
}

/** Wall-clock time since a run started, in the same "2m 12s" form as the
 * rest of this page (`durationLabel`) — never a fabricated live counter. */
export function elapsedLabel(createdAt: string, now: number): string {
  const startMs = Date.parse(createdAt);
  if (Number.isNaN(startMs)) return "—";
  return durationLabel(Math.max(0, now - startMs));
}

/**
 * "Running now" — a horizontally scrolling strip of the runs actually in
 * flight this instant (`status: running | updating`), not a fabricated
 * live-metrics ticker. Renders nothing when nothing is running, same
 * convention as react-ui's `WorkflowDock`: an empty "nothing running" strip
 * is a permanent fixture reporting the normal case, not an empty state worth
 * showing.
 */
function RunningNowStrip({
  runs,
  onOpenRun,
}: {
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
}) {
  const maybeLive = runs.some((run) => run.status === "running" || run.status === "updating");
  const now = useTickingNow(maybeLive);
  const running = runs.filter((run) => isRunningNow(run, now));
  if (running.length === 0) return null;

  return (
    <section className="insights-running-now" aria-label="Running now">
      <div className="insights-running-now-head">
        <h3>Running now</h3>
        <span className="insights-running-now-count">
          {formatCount(running.length)} in progress
        </span>
      </div>
      <ul className="insights-running-now-strip">
        {running.map((run) => (
          <li key={run.id}>
            <button type="button" className="insights-flight" onClick={() => onOpenRun(run.id)}>
              <StatusDot
                label={runStatusLabel("running")}
                tone={RUN_STATUS_DOT_TONE.running}
                live
              />
              <span className="insights-flight-name">{runDisplayName(run)}</span>
              <span className="insights-flight-elapsed">{elapsedLabel(run.createdAt, now)}</span>
              <Badge tone={RUN_STATUS_TONE.running}>{runStatusLabel("running")}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
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
                <strong className="truncate text-sm font-semibold">{runDisplayName(row)}</strong>
                <span className="truncate text-xs text-muted-foreground">
                  {formatWhen(row.createdAt)}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <Badge tone={insightsStatusTone(insightsRunStatus(row))}>
                {runStatusLabel(insightsRunStatus(row))}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
        <TableRow {...onRowActivate(onOpenRuns)}>
          <TableCell colSpan={2} className="font-semibold text-primary-emphasis">
            All runs →
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function InsightsLanding({
  runs,
  runsNextCursor,
  routines,
  loading,
  onOpenRun,
  onOpenRuns,
}: {
  readonly runs: readonly InsightsRun[];
  /** The feed's own `nextCursor` (`limit=100` fetch, see
   * `insightsTopLevelRunsPath`) — non-null means more runs exist than the
   * 100 fetched, so the KPIs below disclose the cap instead of silently
   * presenting a truncated series as complete. */
  readonly runsNextCursor: string | null;
  readonly routines: readonly ScheduledWorkflowDefinition[];
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
}) {
  const stats = computeInsightsStats(runs, routines);
  const purposeRuns = purposeRunsForInsights(runs);
  const runningNow = purposeRuns.filter((run) => isRunningNow(run));
  const recent = purposeRuns.slice(0, 12);

  return (
    <div className="insights-layout">
      <StatGrid columns={4}>
        <InsightsStat
          label="Runs"
          value={tileValue(formatCount(stats.totalRuns), loading)}
          detail={runsDetailLabel(stats)}
          onClick={onOpenRuns}
          loading={loading}
        />
        <InsightsStat
          label="Errored"
          value={tileValue(formatCount(stats.errored), loading)}
          detail="failed runs"
          loading={loading}
        />
        <InsightsStat
          label="Deployed"
          value={tileValue(formatCount(stats.deployed), loading)}
          detail="live definitions"
          loading={loading}
        />
        {runningNow.length > 0 || loading ? (
          <InsightsStat
            label="Running now"
            value={tileValue(formatCount(runningNow.length), loading)}
            detail="in flight"
            loading={loading}
          />
        ) : null}
      </StatGrid>

      <RunningNowStrip runs={runningNow} onOpenRun={onOpenRun} />

      {runsNextCursor !== null ? (
        <p className="insights-note">
          Runs and outcomes below reflect the 100 most recent runs — more exist.{" "}
          <button
            type="button"
            className="font-semibold text-primary-emphasis"
            onClick={onOpenRuns}
          >
            See all runs
          </button>
          .
        </p>
      ) : null}

      <section className="insights-section">
        <div className="insights-section-head">
          <h2>Recent runs</h2>
        </div>
        {recent.length > 0 ? (
          <RecentRunRows runs={recent} onOpenRun={onOpenRun} onOpenRuns={onOpenRuns} />
        ) : (
          <RichEmptyState
            icon={<ChartBar />}
            title="No runs yet"
            description="When a routine or automation fires, it shows up here."
          />
        )}
      </section>
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
                <Badge tone={insightsStatusTone(insightsRunStatus(row))}>
                  {runStatusLabel(insightsRunStatus(row))}
                </Badge>
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
}: {
  readonly runs: readonly InsightsRun[];
  readonly loading: boolean;
  /** The feed's own `nextCursor` (from `insightsTopLevelRunsPath`'s
   * `limit=100` fetch) — non-null means more runs exist than were fetched,
   * so the view says so instead of silently truncating at 100. */
  readonly nextCursor: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  const purpose = purposeRunsForInsights(runs);
  const groups = groupRunsByDefinition(purpose);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Insights", href: INSIGHTS_PATH_PREFIX }, { label: "Run history" }]}
        subtitle={`${purpose.length} runs`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : groups.length === 0 ? (
              <RichEmptyState
                icon={<ChartBar />}
                title="No runs yet"
                description="When a routine or automation fires, it shows up here."
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
                  <p className="insights-note">Showing the 100 most recent runs.</p>
                ) : null}
              </>
            )}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRunDetail({ run }: { readonly run: InsightsRun | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Runs", href: INSIGHTS_RUNS_PATH },
          { label: run !== null ? runDisplayName(run) : "Run" },
        ]}
        subtitle={run !== null ? formatWhen(run.createdAt) : null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            <StatGrid columns={3}>
              <InsightsStat
                label="Status"
                value={run !== null ? runStatusLabel(insightsRunStatus(run)) : "—"}
              />
              <InsightsStat
                label="Started"
                value={run !== null ? formatWhen(run.createdAt) : "—"}
              />
              <InsightsStat label="Duration" value={run !== null ? runDurationLabel(run) : "—"} />
            </StatGrid>
            {run === null ? (
              <RichEmptyState
                title="Run not found"
                description="This run may have fallen out of the 100 most recent, or it never existed."
              />
            ) : null}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsPage({
  path,
  runs,
  routines,
}: {
  readonly path: string;
  readonly runs: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }>;
  readonly routines: APIQuery<readonly ScheduledWorkflowDefinition[]>;
}) {
  const navigate = useNavigate();
  const { mode, runId } = parseInsightsPath(path);

  const unauth = runs.kind === "unauthenticated" || routines.kind === "unauthenticated";

  if (unauth) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <SignedOutNotice />
        </PageShell>
      </div>
    );
  }

  const loading = runs.kind === "loading" || routines.kind === "loading";

  const runsData = runs.kind === "ready" ? runs.data.data : [];
  const runsNextCursor = runs.kind === "ready" ? runs.data.nextCursor : null;
  const routinesData = routines.kind === "ready" ? routines.data : [];

  if (mode === "run" && runId !== null) {
    const run = runsData.find((r) => r.id === runId) ?? null;
    return <InsightsRunDetail run={run} />;
  }

  if (mode === "runs") {
    return (
      <InsightsRunsHistory
        runs={runsData}
        loading={runs.kind === "loading"}
        nextCursor={runsNextCursor}
        onOpenRun={(id) => navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)}
      />
    );
  }

  if (runs.kind === "error") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="Couldn't load insights"
            description="Something went wrong on our side. Try again in a moment."
            actions={[{ label: "Retry", onClick: runs.retry }]}
          />
        </PageShell>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: "Insights" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <InsightsLanding
            runs={runsData}
            runsNextCursor={runsNextCursor}
            routines={routinesData}
            loading={loading}
            onOpenRun={(id) => navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)}
            onOpenRuns={() => navigate(INSIGHTS_RUNS_PATH)}
          />
        </PageShell>
      </div>
    </div>
  );
}

/**
 * Insights scoped to one workbench — `/insights/workbench/:workbenchId`
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
  readonly resolution: ReturnType<typeof resolveWorkbenchInsightsScope>;
  readonly benchTenantId: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  if (workbenchesLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <Skeleton className="h-48 w-full" />
        </PageShell>
      </div>
    );
  }
  if (resolution.kind === "not-found") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
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
        <StageTopBar crumbs={[{ label: "Insights" }]} />
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
        crumbs={[{ label: "Insights", href: INSIGHTS_PATH_PREFIX }, { label: resolution.title }]}
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
    path ?? (typeof window !== "undefined" ? window.location.pathname : INSIGHTS_PATH_PREFIX);
  const { mode, workbenchId } = parseInsightsPath(currentPath);

  const runs = useAPIQuery(
    selectedTenantId === null ? "" : insightsTopLevelRunsPath(selectedTenantId),
    TopLevelRunsSchema,
  );
  const routines = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "routines"]
      : tenantKeys.routines(selectedTenantId),
    selectedTenantId !== null,
    () => listScheduledWorkflows(selectedTenantId as string),
  );

  const routinesForPage: APIQuery<readonly ScheduledWorkflowDefinition[]> =
    selectedTenantId === null ? { kind: "ready", data: [] } : routines;

  const runsForPage: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }> = selectedTenantId === null ? { kind: "ready", data: { data: [], nextCursor: null } } : runs;

  if (mode === "workbench" && workbenchId !== null) {
    return (
      <InsightsWorkbenchPageRoute
        workbenchId={workbenchId}
        benchTenantId={selectedTenantId}
        onOpenRun={(id) => navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)}
      />
    );
  }

  return <InsightsPage path={currentPath} runs={runsForPage} routines={routinesForPage} />;
}

/** Resolves the workbench-scoped route's own workbench list — split out of
 * `InsightsRoute` so the landing/runs/run-detail modes above never pay for
 * a workbench-list fetch they don't need. */
function InsightsWorkbenchPageRoute({
  workbenchId,
  benchTenantId,
  onOpenRun,
}: {
  readonly workbenchId: string;
  readonly benchTenantId: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  const { workbenches, chats, isLoading } = useWorkbenchAndChatLists(benchTenantId);
  const resolution = resolveWorkbenchInsightsScope([...workbenches, ...chats], workbenchId);
  return (
    <InsightsWorkbenchPage
      workbenchId={workbenchId}
      workbenchesLoading={isLoading}
      resolution={resolution}
      benchTenantId={benchTenantId}
      onOpenRun={onOpenRun}
    />
  );
}

function useWorkbenchAndChatLists(tenantId: string | null) {
  const workbenchesOfKind = useTenantQuery(
    tenantId === null
      ? ["tenant", "none", "workbenches", "workbench"]
      : workbenchesQueryKey(tenantId, "workbench"),
    tenantId !== null,
    () => listWorkbenches(tenantId as string, "workbench"),
  );
  const chatsOfKind = useTenantQuery(
    tenantId === null
      ? ["tenant", "none", "workbenches", "chat"]
      : workbenchesQueryKey(tenantId, "chat"),
    tenantId !== null,
    () => listWorkbenches(tenantId as string, "chat"),
  );
  return {
    workbenches: workbenchesOfKind.kind === "ready" ? workbenchesOfKind.data : [],
    chats: chatsOfKind.kind === "ready" ? chatsOfKind.data : [],
    isLoading: workbenchesOfKind.kind === "loading" || chatsOfKind.kind === "loading",
  };
}
