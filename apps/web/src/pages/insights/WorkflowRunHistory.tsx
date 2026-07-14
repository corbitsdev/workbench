import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AppPageChromeRow, toHumanLabel } from "@workbench/ui";
import { useSetPageChrome } from "../../lib/page-chrome";
import { InsightsBackLink } from "./tracer-shell";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import {
  useArchiveWorkflowRun,
  useWorkflowRuns,
  type WorkflowRun,
} from "../../hooks/use-workflow";
import {
  ALL_ACTORS,
  ALL_KINDS,
  DEFAULT_RUN_FILTERS,
  applyRunFilters,
  distinctRunActors,
  distinctRunKinds,
  type RunFilters,
  type RunSort,
  type RunStatusFilter,
} from "../../lib/workflow-run-filters";
import {
  SORT_OPTIONS,
  STATUS_FILTER_OPTIONS,
  formatRunWhen,
  statusDotClass,
  statusLabel,
  statusTextClass,
} from "../../lib/workflow-run-status";

const toolbarSelectClass =
  "h-[34px] rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text focus:border-border-strong focus:outline-none";

function StatusFilterControl({
  value,
  onChange,
}: {
  value: RunStatusFilter;
  onChange: (next: RunStatusFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter by status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {STATUS_FILTER_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`relative py-1 text-[12px] font-medium transition-colors ${
              active ? "text-text" : "text-text-3 hover:text-text"
            }`}
          >
            {opt.label}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function RunRow({
  run,
  archiving,
  onArchive,
}: {
  run: WorkflowRun;
  archiving: boolean;
  onArchive: () => void;
}) {
  // Only the run's starter can archive it (the server gates archive to the
  // owner); hide the control on other members' runs so it never dangles into a
  // 403 (CL-3667). `isSelf` is absent only on legacy payloads — treat that as
  // the caller's own run to preserve the pre-tenant-scope behavior.
  const canArchive = run.isSelf !== false;
  // Two-tap confirm mirrors the app's destructive-confirm pattern: archiving is
  // a permanent teardown, so the first click arms and the second commits.
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      onMouseLeave={() => setConfirming(false)}
      className="group relative flex w-full items-stretch rounded-[9px] transition-colors hover:bg-row-hover"
    >
      <Link
        to={
          run.status === "awaiting"
            ? `/workflows/${run.runId}`
            : `/insights/trace/${run.runId}`
        }
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
      >
        <span
          aria-hidden="true"
          className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(run.status)}`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium text-text">
              {toHumanLabel(run.kind)}
            </span>
            <span
              className={`shrink-0 text-[11px] font-medium ${statusTextClass(run.status)}`}
            >
              {statusLabel(run.status)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-text-3">
            <span className="tabular-nums">{formatRunWhen(run.createdAt)}</span>
            {run.ownerDisplayName !== undefined && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  {run.isSelf ? "You" : run.ownerDisplayName}
                </span>
              </>
            )}
          </span>
        </span>
      </Link>
      {canArchive &&
        (confirming ? (
          <div className="flex shrink-0 items-center gap-1 pr-1">
            <button
              type="button"
              disabled={archiving}
              onClick={() => {
                setConfirming(false);
                onArchive();
              }}
              aria-label={`Confirm: stop and remove ${run.kind} run — frees its resources, cannot be undone`}
              className="rounded-[7px] bg-red-500 px-2 py-1 text-[11px] font-medium text-white transition-transform hover:bg-red-600 active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100"
            >
              {archiving ? "Stopping…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              aria-label={`Cancel archiving ${run.kind} run`}
              className="rounded-[7px] px-2 py-1 text-[11px] text-text-3 transition-transform hover:text-text active:scale-[0.97] motion-reduce:active:scale-100"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Archive — stops the run and frees its resources (cannot be undone)"
            aria-label={`Archive ${run.kind} run`}
            className="shrink-0 px-2.5 text-[11px] text-text-3 opacity-100 transition-[opacity,transform] hover:text-text focus:opacity-100 active:scale-[0.97] hover-hover:opacity-0 hover-hover:focus:opacity-100 hover-hover:group-hover:opacity-100 motion-reduce:active:scale-100"
          >
            Archive
          </button>
        ))}
    </div>
  );
}

/**
 * The browsable workflow run history (`/insights/runs`). Lists every run for the
 * active workbench with status/kind filters, search, and sort; each row opens
 * the read-only execution trace at `/insights/trace/:runId`. This is the single
 * home for run history — the Workflows page carries only the launch catalog
 * and the active-run strip. An `awaiting` row opens the interactive pane at
 * `/workflows/:runId` instead of the trace, since that run needs a human gate
 * completed, not a post-mortem.
 */
export function WorkflowRunHistory() {
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();
  const {
    data: runs,
    isLoading,
    isError,
    refetch,
    // CL-3667: the run-history surface lists every run in the workbench so it
    // can be filtered by who started it, unlike the caller-scoped sidebar.
  } = useWorkflowRuns(activeTenantId, { scope: "tenant" });
  const [filters, setFilters] = useState<RunFilters>(DEFAULT_RUN_FILTERS);
  const archiveRun = useArchiveWorkflowRun(activeTenantId);

  const allRuns = runs ?? [];
  const kindOptionsByLabel = useMemo(
    () =>
      [...distinctRunKinds(allRuns)].sort((a, b) =>
        toHumanLabel(a).localeCompare(toHumanLabel(b)),
      ),
    [allRuns],
  );
  const actorOptions = useMemo(() => distinctRunActors(allRuns), [allRuns]);
  const filtersAreDefault =
    filters.status === DEFAULT_RUN_FILTERS.status &&
    filters.kind === DEFAULT_RUN_FILTERS.kind &&
    filters.sort === DEFAULT_RUN_FILTERS.sort &&
    filters.actor === DEFAULT_RUN_FILTERS.actor &&
    filters.search.trim() === "";
  const visibleRuns = useMemo(
    () => applyRunFilters(allRuns, filters),
    [allRuns, filters],
  );
  const showFilters = !isLoading && !isError && allRuns.length > 0;

  const pageChrome = useMemo(
    () => (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <InsightsBackLink to="/insights?tab=workflows" />
        <AppPageChromeRow
          title="Run history"
          titleSize="sm"
          className="flex-none [&_h1]:text-[20px] [&_h1]:tracking-[-0.01em]"
        >
          {showFilters && (
            <span className="text-[12px] tabular-nums text-text-3">
              {visibleRuns.length} shown
            </span>
          )}
        </AppPageChromeRow>
      </div>
    ),
    [showFilters, visibleRuns.length],
  );
  useSetPageChrome(pageChrome);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-6 py-8">
        {showFilters && (
          <div className="flex flex-col gap-3 rounded-[12px] border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="search"
                aria-label="Search runs"
                placeholder="Search runs…"
                className="h-[34px] min-w-[200px] flex-1 rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
                value={filters.search}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, search: e.target.value }))
                }
              />
              <select
                aria-label="Filter by workflow kind"
                className={toolbarSelectClass}
                value={filters.kind}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, kind: e.target.value }))
                }
              >
                <option value={ALL_KINDS}>All workflows</option>
                {kindOptionsByLabel.map((kind) => (
                  <option key={kind} value={kind}>
                    {toHumanLabel(kind)}
                  </option>
                ))}
              </select>
              {actorOptions.length > 1 && (
                <select
                  aria-label="Filter by who started the run"
                  className={toolbarSelectClass}
                  value={filters.actor}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, actor: e.target.value }))
                  }
                >
                  <option value={ALL_ACTORS}>All people</option>
                  {actorOptions.map((actor) => (
                    <option key={actor.principalId} value={actor.principalId}>
                      {actor.label}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="Sort runs"
                className={toolbarSelectClass}
                value={filters.sort}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    sort: e.target.value as RunSort,
                  }))
                }
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <StatusFilterControl
                value={filters.status}
                onChange={(status) => setFilters((f) => ({ ...f, status }))}
              />
              {!filtersAreDefault && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_RUN_FILTERS)}
                  className="shrink-0 text-[12px] font-medium text-text-2 underline hover:text-text"
                >
                  Reset filters
                </button>
              )}
            </div>
          </div>
        )}

        {isLoading && <p className="text-[13px] text-text-2">Loading runs…</p>}
        {isError && (
          <div className="flex flex-col items-start gap-2 text-[13px] text-text-2">
            <span>Couldn&rsquo;t load workflow runs.</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="text-blue underline hover:text-blue-deep"
            >
              Try again
            </button>
          </div>
        )}
        {!isLoading && !isError && allRuns.length === 0 && (
          <p className="text-[13px] text-text-2">
            No workflow runs yet. Start one from the{" "}
            <button
              type="button"
              onClick={() => navigate("/workflows")}
              className="text-blue underline hover:text-blue-deep"
            >
              Workflows catalog
            </button>
            .
          </p>
        )}
        {!isLoading && !isError && allRuns.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {archiveRun.isError && (
              <div className="mb-1 rounded-[8px] bg-row-hover px-2.5 py-2 text-[11px] text-red-500">
                Couldn&rsquo;t archive that run. Try again.
              </div>
            )}
            {visibleRuns.length === 0 ? (
              <p className="px-2 py-4 text-[13px] text-text-2">
                No runs match the current filters.
              </p>
            ) : (
              visibleRuns.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  archiving={
                    archiveRun.isPending && archiveRun.variables === run.runId
                  }
                  onArchive={() => {
                    archiveRun.mutateAsync(run.runId).catch(() => {});
                  }}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
