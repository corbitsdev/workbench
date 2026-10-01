// The stock observability routes are unimplemented 501 stubs, so this
// page is entirely native `WorkflowRunResponse` data.

import {
  Badge,
  PageShell,
  RichEmptyState,
  RUN_STATUS_TONE,
  Skeleton,
  StatGrid,
  StatGridItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeTone,
  type RunStatus,
} from "@corbits/react-ui";
import { ChartBar } from "@/lib/icons";
import { runOutcomeStatus, runStatusLabel, withListingAbandoned } from "@corbits/workflows/client";
import type * as React from "react";
import { useState } from "react";

import { workflowRunStatuses, type WorkflowRunStatus } from "@intx/types";
import { SignedOutNotice, type APIQuery } from "@/lib/api-query";
import { workbenchesQueryKey, listWorkbenches } from "@/chat/workbench-tenants";

import { useBench } from "../bench-context";
import { readLastWorkbenchId } from "../last-workbench";
import { Redirect } from "../redirect";
import { NEW_WORKBENCH_PATH } from "../routes";
import { workbenchInsightsPath } from "../insights-deeplinks";
import { BenchInsights } from "./bench-insights";
import { resolveWorkbenchInsightsScope } from "../insights-workbench-scope";
import { parseInsightsPath } from "../insights-path";
import {
  insightsTopLevelRunsPath,
  insightsRunEventsPath,
  RunEventsSchema,
  runFailureMessage,
  TopLevelRunsSchema,
  type InsightsRun,
} from "../insights-api";
import {
  durationLabel,
  groupRunsByDefinition,
  purposeRunsForInsights,
  runDisplayName,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { useAPIQuery } from "../api";
import { INSIGHTS_PATH_PREFIX, INSIGHTS_RUNS_PATH } from "../path-ids";
import { benchLink, useFromBench } from "../shell/page-crumbs";
import { StageTopBar } from "../shell/stage-top-bar";
import { useTenantQuery } from "../routines-api";
import "./insights-page.css";

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

// Normalizes onto react-ui's `RunStatus` vocabulary so the tone always
// comes from `RUN_STATUS_TONE`, never a second opinion invented here.
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
      <div className="insights-stat-loading">
        <span className="insights-stat-label">{label}</span>
        <Skeleton className="skeleton-stat" />
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

function insightsRunStatus(run: InsightsRun, now: number = Date.now()): string {
  return runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
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
    <div className="page-frame">
      <StageTopBar
        crumbs={[{ label: "Insights", href: INSIGHTS_PATH_PREFIX }, { label: "Run history" }]}
        subtitle={`${purpose.length} runs`}
      />
      <div className="page-scroll">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            {loading ? (
              <Skeleton className="skeleton-panel" />
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

/** The failed run's own explanation plus a link to its full event log,
 * fetched from the stock `GET .../runs/:runId/events` route only for a
 * failed run — a healthy run has nothing to explain. */
function RunFailureDetail({
  tenantId,
  runId,
}: {
  readonly tenantId: string;
  readonly runId: string;
}) {
  const events = useAPIQuery(insightsRunEventsPath(tenantId, runId), RunEventsSchema);
  const [showEvents, setShowEvents] = useState(false);

  if (events.kind === "loading") return <Skeleton className="skeleton-card-lg" />;
  if (events.kind !== "ready") {
    return (
      <RichEmptyState
        title="Couldn't load this run's events"
        description="Something went wrong on our side. Try again in a moment."
        {...(events.kind === "error"
          ? { actions: [{ label: "Retry", onClick: events.retry }] }
          : {})}
      />
    );
  }

  const message = runFailureMessage(events.data.events);

  return (
    <section className="insights-panel">
      <h3>Failure</h3>
      <p className="page-error">
        {message ?? "This run failed, but no event carried a specific error message."}
      </p>
      <button
        type="button"
        className="insights-link-button"
        onClick={() => setShowEvents((value) => !value)}
      >
        {showEvents ? "Hide events" : "View events"}
      </button>
      {showEvents ? (
        <Table aria-label="Run events" className="insights-data-table">
          <TableHeader>
            <TableRow>
              <TableHead>Seq</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.data.events.map((event) => (
              <TableRow key={event.seq}>
                <TableCell>{event.seq}</TableCell>
                <TableCell>{event.type}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}

export function InsightsRunDetail({
  run,
  tenantId,
}: {
  readonly run: InsightsRun | null;
  readonly tenantId: string | null;
}) {
  const failed = run !== null && insightsRunStatus(run) === "failed";
  return (
    <div className="page-frame">
      <StageTopBar
        crumbs={[
          { label: "Runs", href: INSIGHTS_RUNS_PATH },
          { label: run !== null ? runDisplayName(run) : "Run" },
        ]}
        subtitle={run !== null ? formatWhen(run.createdAt) : null}
      />
      <div className="page-scroll">
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
            {failed && tenantId !== null ? (
              <RunFailureDetail tenantId={tenantId} runId={run.id} />
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
  tenantId = null,
}: {
  readonly path: string;
  readonly runs: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }>;
  readonly tenantId?: string | null;
}) {
  const navigate = useNavigate();
  const { mode, runId } = parseInsightsPath(path);

  if (runs.kind === "unauthenticated") {
    return (
      <div className="page-frame">
        <StageTopBar crumbs={[{ label: "Runs" }]} />
        <PageShell width="full" className="page-fill">
          <SignedOutNotice />
        </PageShell>
      </div>
    );
  }

  const runsData = runs.kind === "ready" ? runs.data.data : [];
  const runsNextCursor = runs.kind === "ready" ? runs.data.nextCursor : null;

  if (mode === "run" && runId !== null) {
    const run = runsData.find((r) => r.id === runId) ?? null;
    return <InsightsRunDetail run={run} tenantId={tenantId} />;
  }

  return (
    <InsightsRunsHistory
      runs={runsData}
      loading={runs.kind === "loading"}
      nextCursor={runsNextCursor}
      onOpenRun={(id) => navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)}
    />
  );
}

// Titles the page by the workbench name, never the tenant's. A legacy or
// mis-wired id gets an honest empty state instead of a doomed fetch.
function InsightsWorkbenchPage({
  workbenchId,
  workbenchesLoading,
  resolution,
  onOpenRun,
}: {
  readonly workbenchId: string;
  readonly onOpenRun: (id: string) => void;
  readonly workbenchesLoading: boolean;
  readonly resolution: ReturnType<typeof resolveWorkbenchInsightsScope>;
}) {
  if (resolution.kind === "ready") {
    return (
      <BenchInsights
        tenantId={resolution.tenantId}
        workbenchId={workbenchId}
        title={resolution.title}
        onOpenRun={onOpenRun}
      />
    );
  }
  return (
    <div className="page-frame">
      <StageTopBar crumbs={[{ label: "Insights" }]} />
      <PageShell width="full" className="page-fill">
        {workbenchesLoading ? (
          <Skeleton className="skeleton-panel-lg" />
        ) : (
          <RichEmptyState
            icon={<ChartBar />}
            title={
              resolution.kind === "not-found"
                ? "Workbench not found"
                : "No insights for this workbench yet"
            }
            description={
              resolution.kind === "not-found"
                ? "This workbench may have been deleted, or you may not have access to it."
                : "This workbench predates per-workbench insights."
            }
          />
        )}
      </PageShell>
    </div>
  );
}

// `/insights` with no workbench hops to the last-visited workbench's
// Insights, else the first workbench's, else the new-workbench picker.
function InsightsLandingRedirect({ benchTenantId }: { readonly benchTenantId: string | null }) {
  const navigate = useNavigate();
  const { workbenches, isLoading } = useWorkbenchList(benchTenantId);
  if (isLoading) {
    return (
      <PageShell width="full" className="page-fill">
        <Skeleton className="skeleton-panel-lg" />
      </PageShell>
    );
  }
  const lastId = benchTenantId === null ? null : readLastWorkbenchId(benchTenantId);
  const target = workbenches.find((workbench) => workbench.id === lastId) ?? workbenches[0];
  const to = target === undefined ? NEW_WORKBENCH_PATH : workbenchInsightsPath(target.id);
  return <Redirect to={to} from={INSIGHTS_PATH_PREFIX} navigate={navigate} />;
}

export function InsightsRoute({ path }: { readonly path?: string }) {
  const { selectedTenantId: benchTenantId } = useBench();
  // A run opened from a workbench's Insights carries `from=`, so it reads
  // that workbench's tenant rather than the bench.
  const fromBench = useFromBench();
  const selectedTenantId = fromBench ?? benchTenantId;
  const navigate = useNavigate();
  const currentPath =
    path ?? (typeof window !== "undefined" ? window.location.pathname : INSIGHTS_PATH_PREFIX);
  const { mode, workbenchId } = parseInsightsPath(currentPath);

  const runs = useAPIQuery(
    selectedTenantId === null || mode === "landing" || mode === "workbench"
      ? ""
      : insightsTopLevelRunsPath(selectedTenantId),
    TopLevelRunsSchema,
  );

  if (mode === "landing") return <InsightsLandingRedirect benchTenantId={benchTenantId} />;

  if (mode === "workbench" && workbenchId !== null) {
    return (
      <InsightsWorkbenchPageRoute
        workbenchId={workbenchId}
        benchTenantId={benchTenantId}
        onOpenRun={(id) =>
          navigate(benchLink(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`, workbenchId))
        }
      />
    );
  }

  const runsForPage: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }> = selectedTenantId === null ? { kind: "ready", data: { data: [], nextCursor: null } } : runs;

  return <InsightsPage path={currentPath} runs={runsForPage} tenantId={selectedTenantId} />;
}

/** Resolves the workbench-scoped route's own workbench list. */
function InsightsWorkbenchPageRoute({
  workbenchId,
  benchTenantId,
  onOpenRun,
}: {
  readonly workbenchId: string;
  readonly benchTenantId: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  const { workbenches, isLoading } = useWorkbenchList(benchTenantId);
  const resolution = resolveWorkbenchInsightsScope(workbenches, workbenchId);
  return (
    <InsightsWorkbenchPage
      workbenchId={workbenchId}
      workbenchesLoading={isLoading}
      resolution={resolution}
      onOpenRun={onOpenRun}
    />
  );
}

function useWorkbenchList(tenantId: string | null) {
  const workbenchesOfKind = useTenantQuery(
    tenantId === null ? ["tenant", "none", "workbenches"] : workbenchesQueryKey(tenantId),
    tenantId !== null,
    () => listWorkbenches(tenantId as string),
  );
  return {
    workbenches: workbenchesOfKind.kind === "ready" ? workbenchesOfKind.data : [],
    isLoading: workbenchesOfKind.kind === "loading",
  };
}
