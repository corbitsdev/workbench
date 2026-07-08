import { useMemo } from "react";
import { toHumanLabel } from "@workbench/ui";
import type { WorkflowRun } from "../hooks/use-workflow";
import type { RunStatusFilter } from "../lib/workflow-run-filters";
import { formatRelativeTime } from "../lib/relative-time";
import { statusDotClass, statusLabel } from "../pages/WorkflowsPage";

type RunStatus = WorkflowRun["status"];

// Failures are deliberately absent — the dashboard never surfaces a failed
// count. The catalog is the only launch path, so there is no New run button.
const STAT_STATUSES: RunStatus[] = [
  "provisioning",
  "running",
  "awaiting",
  "completed",
];

// "2h" / "3d" carry "ago"; "just now" and absolute dates ("Apr 3") read wrong
// with it, so they pass through unchanged.
function relativeAgo(iso: string): string {
  const rel = formatRelativeTime(iso);
  if (/^\d+[mhd]$/.test(rel)) return `${rel} ago`;
  return rel;
}

export interface WorkflowsDashboardProps {
  runs: WorkflowRun[];
  isLoading: boolean;
  isError: boolean;
  pinned: boolean;
  statusFilter: RunStatusFilter;
  selectedRunMissing: boolean;
  onSelectRun: (runId: string) => void;
  onFilterStatus: (status: RunStatus) => void;
  onShowAll: () => void;
  catalog: React.ReactNode;
}

function StatusMetric({
  status,
  count,
  active,
  first,
  onClick,
}: {
  status: RunStatus;
  count: number;
  active: boolean;
  first: boolean;
  onClick: () => void;
}) {
  const label = statusLabel(status);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Show ${String(count)} ${label.toLowerCase()} runs`}
      onClick={onClick}
      className={`flex flex-1 items-center gap-2.5 px-4 py-3 text-left transition-colors duration-150 ease-[var(--ease)] hover:bg-row-hover focus:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-border-strong ${
        first ? "rounded-l-[10px]" : "border-l border-border"
      } ${active ? "bg-row-hover" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)} ${count === 0 ? "opacity-30" : ""}`}
      />
      <span className="flex flex-col gap-0.5 leading-none">
        <span
          className={`text-[20px] font-semibold tabular-nums ${count === 0 ? "text-text-3" : "text-text"}`}
        >
          {count}
        </span>
        <span className="text-[11px] uppercase tracking-[0.04em] text-text-3">
          {label}
        </span>
      </span>
    </button>
  );
}

function StatusSummary({
  counts,
  statusFilter,
  onFilterStatus,
}: {
  counts: Record<RunStatus, number>;
  statusFilter: RunStatusFilter;
  onFilterStatus: (status: RunStatus) => void;
}) {
  return (
    <div className="flex items-stretch rounded-[12px] border border-border bg-surface">
      {STAT_STATUSES.map((status, i) => (
        <StatusMetric
          key={status}
          status={status}
          count={counts[status]}
          active={statusFilter === status}
          first={i === 0}
          onClick={() => onFilterStatus(status)}
        />
      ))}
    </div>
  );
}

function StatusSummarySkeleton() {
  return (
    <div className="flex h-[66px] items-center rounded-[12px] border border-border bg-surface" />
  );
}

function ActiveCard({
  run,
  onSelect,
}: {
  run: WorkflowRun;
  onSelect: () => void;
}) {
  const awaiting = run.status === "awaiting";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface p-3 text-left transition-[background-color,transform] duration-150 ease-[var(--ease)] hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong active:scale-[0.98] motion-reduce:active:scale-100 motion-reduce:transition-none ${
        awaiting ? "border-l-2 border-l-blue" : ""
      }`}
    >
      <span className="truncate text-[13px] font-medium text-text">
        {toHumanLabel(run.kind)}
      </span>
      <span className="flex items-center gap-1.5 text-[12px] text-blue">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-blue" />
        {awaiting ? "Needs you" : "Running"}
      </span>
      <span className="text-[11px] text-text-3 tabular-nums">
        started {relativeAgo(run.createdAt)}
      </span>
    </button>
  );
}

export function WorkflowsDashboard({
  runs,
  isLoading,
  isError,
  pinned,
  statusFilter,
  selectedRunMissing,
  onSelectRun,
  onFilterStatus,
  onShowAll,
  catalog,
}: WorkflowsDashboardProps) {
  const counts = useMemo(() => {
    const base: Record<RunStatus, number> = {
      provisioning: 0,
      running: 0,
      awaiting: 0,
      completed: 0,
      failed: 0,
    };
    for (const run of runs) base[run.status] += 1;
    return base;
  }, [runs]);

  const activeRuns = useMemo(() => {
    const active = runs.filter(
      (r) =>
        r.status === "provisioning" ||
        r.status === "running" ||
        r.status === "awaiting",
    );
    return active.sort((a, b) => {
      if (a.status !== b.status) return a.status === "awaiting" ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [runs]);

  const insetClass = pinned ? "pl-[20rem]" : "";

  const missingNote = selectedRunMissing ? (
    <p className="mb-4 text-[12.5px] text-text-3">
      That run is no longer available.
    </p>
  ) : null;

  const wrap = (content: React.ReactNode) => (
    <div className="@container h-full overflow-y-auto">
      <div
        className={`min-h-full transition-[padding] duration-200 ease-[var(--ease)] motion-reduce:transition-none ${insetClass}`}
      >
        {content}
      </div>
    </div>
  );

  if (isLoading) {
    return wrap(
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        {missingNote}
        <StatusSummarySkeleton />
      </div>,
    );
  }

  if (isError) {
    return wrap(
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        {missingNote}
        <p className="text-[13px] text-text-2">
          Couldn&rsquo;t load your workflows. Open the run list to retry.
        </p>
      </div>,
    );
  }

  if (runs.length === 0) {
    return wrap(
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          {missingNote}
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">
            No workflows yet
          </h1>
          <p className="text-[13px] text-text-2">
            Start a workflow from the catalog below and it will show up here.
          </p>
        </div>
        {catalog}
      </div>,
    );
  }

  return wrap(
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      {missingNote}

      <div className="mb-6 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">
          Workflows
        </h1>
        <button
          type="button"
          onClick={onShowAll}
          className="text-[12px] text-text-3 underline hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        >
          View all runs
        </button>
      </div>

      <div className="flex flex-col gap-8">
        <StatusSummary
          counts={counts}
          statusFilter={statusFilter}
          onFilterStatus={onFilterStatus}
        />

        {activeRuns.length === 0 ? (
          <p className="text-[13px] text-text-3">
            No active runs. Start one from the catalog below.
          </p>
        ) : (
          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-text">Active</h2>
              <span className="text-[12px] text-text-3 tabular-nums">
                {activeRuns.length}
              </span>
            </div>
            <div className="grid gap-3 @[640px]:grid-cols-2 @[980px]:grid-cols-3">
              {activeRuns.map((run) => (
                <ActiveCard
                  key={run.runId}
                  run={run}
                  onSelect={() => onSelectRun(run.runId)}
                />
              ))}
            </div>
          </section>
        )}

        {catalog}
      </div>
    </div>,
  );
}
