import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toHumanLabel, useArchivedWorkflowRuns } from "@workbench/ui";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { UnifiedCatalogModal } from "../components/layout/UnifiedCatalogModal";
import { WorkflowRunPane } from "../components/WorkflowRunPane";
import { WorkflowsDashboard } from "../components/WorkflowsDashboard";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import {
  useStartWorkflow,
  useWorkflowRuns,
  type WorkflowRun,
} from "../hooks/use-workflow";
import {
  ALL_KINDS,
  DEFAULT_RUN_FILTERS,
  applyRunFilters,
  distinctRunKinds,
  type RunFilters,
  type RunSort,
  type RunStatusFilter,
} from "../lib/workflow-run-filters";

const OVERLAY_ID = "workflow-rail-overlay";
const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 260;

const STATUS_FILTER_OPTIONS: { value: RunStatusFilter; label: string }[] = [
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
  "h-[34px] w-full rounded-[9px] border border-border bg-page px-[11px] text-[12.5px] text-text focus:border-border-strong focus:outline-none";

function prefersCoarsePointer(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

export function statusLabel(status: string): string {
  const match = STATUS_FILTER_OPTIONS.find((opt) => opt.value === status);
  return match ? match.label : toHumanLabel(status);
}

function statusTextClass(status: string): string {
  if (status === "completed") return "text-green";
  if (status === "failed") return "text-red-500";
  return "text-blue";
}

export function statusDotClass(status: string): string {
  if (status === "completed") return "bg-green";
  if (status === "failed") return "bg-red-500";
  return "bg-blue";
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9 3.5v11M3.5 9h11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 3.5 5.5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
      className={`group relative flex w-full items-stretch rounded-[9px] transition-colors hover:bg-row-hover ${
        selected ? "bg-row-hover" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left"
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
          <span className="text-[11px] text-text-3 tabular-nums">
            {formatWhen(run.createdAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleArchive}
        title={archived ? "Unarchive run" : "Archive run"}
        aria-label={`${archived ? "Unarchive" : "Archive"} ${run.kind} run`}
        className="shrink-0 px-2.5 text-[11px] text-text-3 opacity-100 transition-opacity hover:text-text focus:opacity-100 hover-hover:opacity-0 hover-hover:focus:opacity-100 hover-hover:group-hover:opacity-100"
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
    </div>
  );
}

/**
 * Workflow run history (CL-2309). A calm hover/focus-to-expand left rail keeps
 * the run pane as the hero: the collapsed rail is an ambient status signal
 * (one dot per run) plus New-run + expand affordances, while the run list,
 * search, and filters live in an overlay revealed only on expand.
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

  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [coarsePointer] = useState<boolean>(prefersCoarsePointer);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned || hovering || focusWithin;
  const collapsed = !expanded;

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const clearTimers = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const handleMouseEnter = () => {
    if (coarsePointer) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    openTimer.current = setTimeout(
      () => setHovering(true),
      HOVER_OPEN_DELAY_MS,
    );
  };

  const handleMouseLeave = () => {
    if (coarsePointer) return;
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    closeTimer.current = setTimeout(
      () => setHovering(false),
      HOVER_CLOSE_DELAY_MS,
    );
  };

  const handleFocus = () => setFocusWithin(true);
  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setFocusWithin(false);
  };

  const togglePinned = () => setPinned((prev) => !prev);

  const collapseRail = () => {
    clearTimers();
    setPinned(false);
    setHovering(false);
    if (typeof document !== "undefined") {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  };

  const startWorkflow = useStartWorkflow(activeTenantId);
  const startingKind = startWorkflow.isPending
    ? (startWorkflow.variables?.kind ?? null)
    : null;
  const handleRunKind = (kind: string) => {
    if (startWorkflow.isPending) return;
    startWorkflow
      .mutateAsync({ kind, input: {} })
      .then((res) => navigate(`/workflows/${res.runId}`))
      .catch(() => setCatalogOpen(true));
  };

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
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <div
        className="relative z-40 h-full shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
      >
        <div className="flex h-full w-14 flex-col items-center gap-3 border-r border-border bg-page py-3">
          <div
            aria-hidden="true"
            className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-hidden py-1"
          >
            {visibleRuns.map((run) => {
              const isSelected = run.runId === selectedRunId;
              return (
                <span
                  key={run.runId}
                  title={`${toHumanLabel(run.kind)} — ${statusLabel(run.status)}`}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(run.status)} ${
                    isSelected ? "opacity-100 ring-1 ring-text" : "opacity-50"
                  }`}
                />
              );
            })}
          </div>

          {/* Keyboard entry point — the rail expands on hover for pointer
              users, so this stays visually hidden but tab-reachable. */}
          <button
            type="button"
            onClick={togglePinned}
            aria-controls={OVERLAY_ID}
            aria-expanded={expanded}
            className="sr-only focus-visible:not-sr-only focus-visible:grid focus-visible:h-9 focus-visible:w-9 focus-visible:place-items-center focus-visible:rounded-[9px] focus-visible:bg-row-hover focus-visible:text-[10px] focus-visible:text-text"
          >
            Expand run list
          </button>
        </div>

        <div
          id={OVERLAY_ID}
          aria-hidden={collapsed}
          inert={collapsed}
          style={{
            transitionProperty: "transform, opacity",
            transitionTimingFunction: "var(--ease)",
            transitionDuration: expanded ? "200ms" : "150ms",
          }}
          className={`absolute inset-y-0 left-0 z-10 flex w-80 flex-col border-r border-border bg-surface shadow ${
            expanded
              ? "translate-x-0 opacity-100"
              : "-translate-x-full opacity-0 pointer-events-none motion-reduce:translate-x-0"
          }`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-text">
                Workflow runs
              </h1>
              {showFilters && (
                <span className="text-[12px] text-text-3 tabular-nums">
                  {visibleRuns.length} shown
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={collapseRail}
              aria-controls={OVERLAY_ID}
              aria-expanded={expanded}
              aria-label="Collapse run list and filters"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-row-hover hover:text-text"
            >
              <ChevronLeftIcon />
            </button>
          </div>

          <div className="px-4 pb-3">
            <button
              type="button"
              onClick={() => setCatalogOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-[9px] border border-border bg-page py-2 text-[13px] font-medium text-text transition-colors hover:border-border-strong hover:bg-row-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong active:scale-[0.99] motion-reduce:active:scale-100"
            >
              <PlusIcon />
              New run
            </button>
          </div>

          {showFilters && (
            <div className="flex flex-col gap-2.5 border-b border-border px-4 pb-3">
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
              <StatusFilterControl
                value={filters.status}
                onChange={(status) => setFilters((f) => ({ ...f, status }))}
              />
              <div className="flex flex-col gap-2">
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
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_RUN_FILTERS)}
                  className="self-start text-[12px] font-medium text-text-2 underline hover:text-text"
                >
                  Reset filters
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-2">
            {isLoading && (
              <div className="px-2 py-4 text-[13px] text-text-2">
                Loading runs…
              </div>
            )}
            {isError && (
              <div className="flex flex-col items-start gap-2 px-2 py-4 text-[13px] text-text-2">
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
              <div className="px-2 py-4 text-[13px] text-text-2">
                No workflow runs yet.
              </div>
            )}
            {!isLoading && !isError && allRuns.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {visibleRuns.length === 0 && showAllArchivedNotice && (
                  <div className="px-2 py-4 text-[13px] text-text-2">
                    {`All runs are archived. Show ${String(archivedCount)} archived to view them.`}
                  </div>
                )}
                {visibleRuns.length === 0 && !showAllArchivedNotice && (
                  <div className="flex flex-col items-start gap-2 px-2 py-4 text-[13px] text-text-2">
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
                    className="w-full px-2.5 py-2 text-left text-[11px] text-text-3 underline hover:text-text"
                  >
                    {showArchived
                      ? "Hide archived runs"
                      : `Show ${String(archivedCount)} archived`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {expanded && coarsePointer && (
        <button
          type="button"
          aria-label="Close run list and filters"
          onClick={collapseRail}
          className="absolute inset-0 z-30 bg-page/20"
        />
      )}

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
          <WorkflowsDashboard
            runs={allRuns}
            isLoading={isLoading}
            isError={isError}
            pinned={pinned}
            statusFilter={filters.status}
            selectedRunMissing={selectedRunMissing}
            onSelectRun={(runId) => navigate(`/workflows/${runId}`)}
            onNewRun={() => setCatalogOpen(true)}
            onRunKind={handleRunKind}
            startingKind={startingKind}
            onFilterStatus={(status) => {
              setFilters((f) => ({ ...f, status }));
              setPinned(true);
            }}
            onShowAll={() => {
              setFilters(DEFAULT_RUN_FILTERS);
              setPinned(true);
            }}
          />
        )}
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
