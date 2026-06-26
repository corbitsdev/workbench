import { useMemo, useState } from "react";
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

const STATUS_OPTIONS: { value: RunStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "awaiting", label: "Awaiting" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const SORT_OPTIONS: { value: RunSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const filterSelectClass =
  "min-w-0 flex-1 rounded-md border border-border bg-page px-3 py-2 text-sm text-text transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus";

function statusClass(status: string): string {
  if (status === "completed") return "text-green-600";
  if (status === "failed") return "text-red-500";
  if (status === "awaiting") return "text-orange";
  return "text-text-2";
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
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-text">
            {toHumanLabel(run.kind)}
          </span>
          <span
            className={`shrink-0 text-xs font-medium capitalize ${statusClass(run.status)}`}
          >
            {run.status}
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
  const { activeTenantId } = useActiveWorkbench();
  const {
    data: runs,
    isLoading,
    isError,
    refetch,
  } = useWorkflowRuns(activeTenantId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [filters, setFilters] = useState<RunFilters>(DEFAULT_RUN_FILTERS);
  const { archived, isArchived, setArchived } = useArchivedWorkflowRuns();

  const allRuns = runs ?? [];
  const archivedCount = useMemo(
    () => allRuns.reduce((n, r) => (archived.has(r.runId) ? n + 1 : n), 0),
    [allRuns, archived],
  );
  const kindOptions = useMemo(() => distinctRunKinds(allRuns), [allRuns]);
  const filtersAreDefault =
    filters.status === DEFAULT_RUN_FILTERS.status &&
    filters.kind === DEFAULT_RUN_FILTERS.kind &&
    filters.sort === DEFAULT_RUN_FILTERS.sort;
  const visibleRuns = useMemo(() => {
    const archiveScoped = showArchived
      ? allRuns
      : allRuns.filter((run) => !archived.has(run.runId));
    return applyRunFilters(archiveScoped, filters);
  }, [allRuns, archived, showArchived, filters]);

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold text-text">Workflow runs</h1>
            <p className="text-xs text-text-3">
              Your workflow execution history
            </p>
          </div>
          <Button size="sm" onClick={() => setCatalogOpen(true)}>
            New run
          </Button>
        </div>
        {!isLoading && !isError && allRuns.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
            <select
              aria-label="Filter by status"
              className={filterSelectClass}
              value={filters.status}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  status: e.target.value as RunStatusFilter,
                }))
              }
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by workflow kind"
              className={filterSelectClass}
              value={filters.kind}
              onChange={(e) =>
                setFilters((f) => ({ ...f, kind: e.target.value }))
              }
            >
              <option value={ALL_KINDS}>All workflows</option>
              {kindOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort runs"
              className={filterSelectClass}
              value={filters.sort}
              onChange={(e) =>
                setFilters((f) => ({ ...f, sort: e.target.value as RunSort }))
              }
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
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
                className="text-orange underline"
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
              {visibleRuns.length === 0 && (
                <div className="px-4 py-6 text-sm text-text-2">
                  {filtersAreDefault && !showArchived && archivedCount > 0
                    ? `All runs are archived. Show ${String(archivedCount)} archived to view them.`
                    : "No runs match the current filters."}
                </div>
              )}
              {visibleRuns.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  selected={run.runId === selectedRunId}
                  archived={archived.has(run.runId)}
                  onSelect={() => setSelectedRunId(run.runId)}
                  onToggleArchive={() => {
                    const nextArchived = !isArchived(run.runId);
                    setArchived(run.runId, nextArchived);
                    if (
                      nextArchived &&
                      !showArchived &&
                      run.runId === selectedRunId
                    ) {
                      setSelectedRunId(null);
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
        {selectedRunId ? (
          <ErrorBoundary>
            <WorkflowRunPane
              deploymentId={selectedRunId}
              tenantId={activeTenantId}
              onClose={() => setSelectedRunId(null)}
            />
          </ErrorBoundary>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-text-3">
            Select a run to view its details
          </div>
        )}
      </div>

      <UnifiedCatalogModal
        open={catalogOpen}
        tenantId={activeTenantId}
        onClose={() => setCatalogOpen(false)}
        onWorkflowStarted={(runId) => {
          setCatalogOpen(false);
          setSelectedRunId(runId);
        }}
      />
    </div>
  );
}
