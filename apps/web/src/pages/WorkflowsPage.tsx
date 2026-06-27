import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, toHumanLabel, useArchivedWorkflowRuns } from "@workbench/ui";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { UnifiedCatalogModal } from "../components/layout/UnifiedCatalogModal";
import { WorkflowRunPane } from "../components/WorkflowRunPane";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useWorkflowRuns, type WorkflowRun } from "../hooks/use-workflow";
import {
  ALL_KINDS,
  DEFAULT_RUN_FILTERS,
  applyRunFilters,
  distinctRunKinds,
  type RunFilters,
  type RunSort,
  type RunStatusFilter,
} from "../lib/workflow-run-filters";

const STATUS_CHIP_OPTIONS: { value: RunStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "awaiting", label: "Awaiting" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const SORT_OPTIONS: { value: RunSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const toolbarSelectClass =
  "h-[34px] w-full rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text focus:border-border-strong focus:outline-none sm:w-auto";

function StatusFilterChips({
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
      className="flex flex-wrap gap-1.5"
    >
      {STATUS_CHIP_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`rounded-[9px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
              active
                ? "border-text bg-text text-page"
                : "border-border bg-page text-text-2 hover:border-border-strong hover:text-text"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function statusLabel(status: string): string {
  const match = STATUS_CHIP_OPTIONS.find((opt) => opt.value === status);
  return match ? match.label : toHumanLabel(status);
}

function statusClass(status: string): string {
  if (status === "completed") return "text-green";
  if (status === "failed") return "text-red-500";
  return "text-blue";
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function RunRow({
  run,
  selected,
  archived,
  onSelect,
  onToggleArchive,
}: {
  run: WorkflowRun;
  selected: boolean;
  archived: boolean;
  onSelect: () => void;
  onToggleArchive: () => void;
}) {
  return (
    <div
      className={`group relative flex w-full items-stretch border-b border-border transition-colors hover:bg-page ${
        selected ? "bg-page" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-text">
            {toHumanLabel(run.kind)}
          </span>
          <span
            className={`shrink-0 text-xs font-medium ${statusClass(run.status)}`}
          >
            {statusLabel(run.status)}
          </span>
        </div>
        <span className="text-xs text-text-3">{formatWhen(run.createdAt)}</span>
      </button>
      <button
        type="button"
        onClick={onToggleArchive}
        title={archived ? "Unarchive run" : "Archive run"}
        aria-label={`${archived ? "Unarchive" : "Archive"} ${run.kind} run`}
        className="shrink-0 px-3 text-xs text-text-3 opacity-100 transition-opacity hover:text-text focus:opacity-100 hover-hover:opacity-0 hover-hover:focus:opacity-100 hover-hover:group-hover:opacity-100"
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
    </div>
  );
}

/**
 * Workflow run history (CL-2309). Lists the member/tenant's workflow execution
 * records; selecting one opens its run detail (and any resume affordance) via
 * the shared WorkflowRunPane.
 */
export function WorkflowsPage() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const navigate = useNavigate();
  const selectedRunId = workflowId ?? null;
  const { activeTenantId } = useActiveWorkbench();
  const {
    data: runs,
    isLoading,
    isError,
    refetch,
  } = useWorkflowRuns(activeTenantId);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [filters, setFilters] = useState<RunFilters>(DEFAULT_RUN_FILTERS);
  const { archived, isArchived, setArchived } = useArchivedWorkflowRuns();

  const allRuns = runs ?? [];
  const selectedRunMissing =
    selectedRunId !== null &&
    !isLoading &&
    !isError &&
    !allRuns.some((run) => run.runId === selectedRunId);
  const archivedCount = useMemo(
    () => allRuns.reduce((n, r) => (archived.has(r.runId) ? n + 1 : n), 0),
    [allRuns, archived],
  );
  const kindOptions = useMemo(() => distinctRunKinds(allRuns), [allRuns]);
  const kindOptionsByLabel = useMemo(
    () =>
      [...kindOptions].sort((a, b) =>
        toHumanLabel(a).localeCompare(toHumanLabel(b)),
      ),
    [kindOptions],
  );
  const filtersAreDefault =
    filters.status === DEFAULT_RUN_FILTERS.status &&
    filters.kind === DEFAULT_RUN_FILTERS.kind &&
    filters.sort === DEFAULT_RUN_FILTERS.sort &&
    filters.search.trim() === "";
  const hasActiveFilters = !filtersAreDefault;
  const visibleRuns = useMemo(() => {
    const archiveScoped = showArchived
      ? allRuns
      : allRuns.filter((run) => !archived.has(run.runId));
    return applyRunFilters(archiveScoped, filters);
  }, [allRuns, archived, showArchived, filters]);

  const showFilters = !isLoading && !isError && allRuns.length > 0;
  const showAllArchivedNotice =
    filtersAreDefault && !showArchived && archivedCount > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">
              Workflow runs
            </h1>
            {showFilters && (
              <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
                {visibleRuns.length} shown
              </span>
            )}
          </div>
          <Button size="sm" onClick={() => setCatalogOpen(true)}>
            New run
          </Button>
        </div>
        {showFilters && (
          <div className="mt-3 flex flex-col gap-3">
            <input
              type="search"
              aria-label="Search runs"
              placeholder="Search runs…"
              className="h-[34px] w-full rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
              value={filters.search}
              onChange={(e) =>
                setFilters((f) => ({ ...f, search: e.target.value }))
              }
            />
            <StatusFilterChips
              value={filters.status}
              onChange={(status) => setFilters((f) => ({ ...f, status }))}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-2 sm:flex-1 sm:flex-row sm:items-center">
                <select
                  aria-label="Filter by workflow kind"
                  className={`${toolbarSelectClass} sm:max-w-md sm:min-w-[220px] sm:flex-1`}
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
                <select
                  aria-label="Sort runs"
                  className={`${toolbarSelectClass} sm:w-[200px] sm:shrink-0`}
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
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_RUN_FILTERS)}
                  className="self-start font-medium text-text-2 underline hover:text-text sm:self-center"
                >
                  Reset filters
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-border bg-surface sm:w-[360px] lg:w-[380px]">
          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading && (
              <div className="px-4 py-6 text-sm text-text-2">Loading runs…</div>
            )}
            {isError && (
              <div className="flex flex-col items-start gap-2 px-4 py-6 text-sm text-text-2">
                <span>Couldn't load workflow runs.</span>
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
              <div className="px-4 py-6 text-sm text-text-2">
                No workflow runs yet.
              </div>
            )}
            {!isLoading && !isError && allRuns.length > 0 && (
              <>
                {visibleRuns.length === 0 && showAllArchivedNotice && (
                  <div className="px-4 py-6 text-sm text-text-2">
                    {`All runs are archived. Show ${String(archivedCount)} archived to view them.`}
                  </div>
                )}
                {visibleRuns.length === 0 && !showAllArchivedNotice && (
                  <div className="flex flex-col items-start gap-2 px-4 py-6 text-sm text-text-2">
                    <span>No runs match the current filters.</span>
                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={() => setFilters(DEFAULT_RUN_FILTERS)}
                        className="font-medium text-text-2 underline hover:text-text"
                      >
                        Reset filters
                      </button>
                    )}
                  </div>
                )}
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.runId}
                    run={run}
                    selected={run.runId === selectedRunId}
                    archived={archived.has(run.runId)}
                    onSelect={() => {
                      if (run.runId === selectedRunId) return;
                      navigate(`/workflows/${run.runId}`);
                    }}
                    onToggleArchive={() => {
                      const nextArchived = !isArchived(run.runId);
                      setArchived(run.runId, nextArchived);
                      if (
                        nextArchived &&
                        !showArchived &&
                        run.runId === selectedRunId
                      ) {
                        navigate("/workflows", { replace: true });
                      }
                    }}
                  />
                ))}
                {archivedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowArchived((v) => !v)}
                    className="w-full px-4 py-3 text-left text-xs text-text-3 underline hover:text-text"
                  >
                    {showArchived
                      ? "Hide archived runs"
                      : `Show ${String(archivedCount)} archived`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-hidden">
          {selectedRunId && !selectedRunMissing ? (
            <ErrorBoundary>
              <WorkflowRunPane
                deploymentId={selectedRunId}
                tenantId={activeTenantId}
                onClose={() => navigate("/workflows", { replace: true })}
              />
            </ErrorBoundary>
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-text-3">
              Select a run to view its details
            </div>
          )}
        </div>
      </div>

      <UnifiedCatalogModal
        open={catalogOpen}
        tenantId={activeTenantId}
        onClose={() => setCatalogOpen(false)}
        onWorkflowStarted={(runId) => {
          setCatalogOpen(false);
          navigate(`/workflows/${runId}`);
        }}
      />
    </div>
  );
}
