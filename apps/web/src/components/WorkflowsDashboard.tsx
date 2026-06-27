import { useMemo, useState } from "react";
import { toHumanLabel } from "@workbench/ui";
import type { WorkflowRun } from "../hooks/use-workflow";
import type { RunStatusFilter } from "../lib/workflow-run-filters";
import { formatRelativeTime } from "../lib/relative-time";
import { statusDotClass, statusLabel } from "../pages/WorkflowsPage";

type RunStatus = WorkflowRun["status"];

const STAT_STATUSES: RunStatus[] = [
  "running",
  "awaiting",
  "completed",
  "failed",
];

const FAVORITE_KINDS_KEY = "workflow-favorite-kinds";

export function readFavoriteKinds(): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(FAVORITE_KINDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

function writeFavoriteKinds(kinds: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FAVORITE_KINDS_KEY, JSON.stringify(kinds));
}

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
  onNewRun: () => void;
  onFilterStatus: (status: RunStatus) => void;
  onShowAll: () => void;
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      aria-hidden="true"
    >
      <path
        d="M8 1.8l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 10.8l-3.52 1.85.67-3.92L2.3 5.94l3.94-.57z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewRunButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-[10px] bg-accent px-3.5 py-2 text-[13px] font-semibold text-white transition-transform duration-150 ease-[var(--ease)] hover:bg-accent-deep active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong motion-reduce:active:scale-100 motion-reduce:transition-none"
    >
      <PlusIcon />
      New run
    </button>
  );
}

function StarButton({
  favorited,
  kindLabel,
  onToggle,
}: {
  favorited: boolean;
  kindLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={favorited}
      aria-label={favorited ? "Remove from favorites" : `Favorite ${kindLabel}`}
      onClick={onToggle}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition-colors duration-150 ease-[var(--ease)] hover:bg-row-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong ${
        favorited ? "text-text-2" : "text-text-3 opacity-60 hover:opacity-100"
      }`}
    >
      <StarIcon filled={favorited} />
    </button>
  );
}

function StatTile({
  status,
  count,
  active,
  onClick,
}: {
  status: RunStatus;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const label = statusLabel(status);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Show ${String(count)} ${label.toLowerCase()} runs`}
      onClick={onClick}
      className={`flex min-h-[92px] flex-col justify-between rounded-[12px] border bg-surface p-3.5 text-left transition-colors duration-150 ease-[var(--ease)] hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong ${
        active ? "border-border-strong" : "border-border"
      }`}
    >
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.04em] text-text-3">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${statusDotClass(status)} ${count === 0 ? "opacity-40" : ""}`}
        />
        {label}
      </span>
      <span className="text-[28px] font-semibold leading-none text-text tabular-nums">
        {count}
      </span>
    </button>
  );
}

function StatTileSkeleton() {
  return (
    <div className="flex min-h-[92px] flex-col justify-between rounded-[12px] border border-border bg-surface p-3.5">
      <span className="h-[11px] w-16 rounded bg-row-hover" />
      <span className="h-[26px] w-10 rounded bg-row-hover" />
    </div>
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
  onNewRun,
  onFilterStatus,
  onShowAll,
}: WorkflowsDashboardProps) {
  const [favoriteKinds, setFavoriteKinds] =
    useState<string[]>(readFavoriteKinds);

  const toggleFavoriteKind = (kind: string) => {
    setFavoriteKinds((prev) => {
      const next = prev.includes(kind)
        ? prev.filter((k) => k !== kind)
        : [...prev, kind];
      writeFavoriteKinds(next);
      return next;
    });
  };

  const counts = useMemo(() => {
    const base: Record<RunStatus, number> = {
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
      (r) => r.status === "running" || r.status === "awaiting",
    );
    return active.sort((a, b) => {
      if (a.status !== b.status) return a.status === "awaiting" ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [runs]);

  // The pinned rail already owns the run list/history; the dashboard's right
  // rail is a forward-looking launcher of the workflow KINDS you run (favorites
  // first), not a second copy of the run list.
  const workflowKinds = useMemo(() => {
    const seen = new Set<string>(favoriteKinds);
    for (const run of runs) seen.add(run.kind);
    return [...seen].sort((a, b) => {
      const favA = favoriteKinds.includes(a);
      const favB = favoriteKinds.includes(b);
      if (favA !== favB) return favA ? -1 : 1;
      return toHumanLabel(a).localeCompare(toHumanLabel(b));
    });
  }, [runs, favoriteKinds]);

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
        <div className="grid grid-cols-2 gap-3 @[640px]:grid-cols-4">
          <StatTileSkeleton />
          <StatTileSkeleton />
          <StatTileSkeleton />
          <StatTileSkeleton />
        </div>
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
      <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        {missingNote}
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">
            No workflows yet
          </h1>
          <p className="text-[13px] text-text-2">
            Start your first workflow and it will show up here.
          </p>
        </div>
        <NewRunButton onClick={onNewRun} />
      </div>,
    );
  }

  return wrap(
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      {missingNote}

      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
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
        <NewRunButton onClick={onNewRun} />
      </div>

      <div className="flex flex-col gap-8 @[860px]:flex-row @[860px]:gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-8">
          <div className="grid grid-cols-2 gap-3 @[640px]:grid-cols-4">
            {STAT_STATUSES.map((status) => (
              <StatTile
                key={status}
                status={status}
                count={counts[status]}
                active={statusFilter === status}
                onClick={() => onFilterStatus(status)}
              />
            ))}
          </div>

          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-text">Active</h2>
              <span className="text-[12px] text-text-3 tabular-nums">
                {activeRuns.length}
              </span>
            </div>
            {activeRuns.length === 0 ? (
              <p className="text-[13px] text-text-2">
                No active workflows.{" "}
                <button
                  type="button"
                  onClick={onNewRun}
                  className="font-medium text-text-2 underline hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
                >
                  Start one
                </button>
                .
              </p>
            ) : (
              <div className="grid gap-3 @[640px]:grid-cols-2">
                {activeRuns.map((run) => (
                  <ActiveCard
                    key={run.runId}
                    run={run}
                    onSelect={() => onSelectRun(run.runId)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {workflowKinds.length > 0 && (
          <aside className="flex flex-col gap-8 @[860px]:w-[260px] @[860px]:shrink-0 @[860px]:self-start @[860px]:sticky @[860px]:top-0 @[860px]:max-h-[calc(100vh-2rem)] @[860px]:overflow-y-auto">
            <section>
              <h2 className="mb-2 text-[13px] font-semibold text-text">
                Your workflows
              </h2>
              <div className="flex flex-col">
                {workflowKinds.map((kind) => (
                  <div key={kind} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate px-2.5 text-[13px] text-text">
                      {toHumanLabel(kind)}
                    </span>
                    <button
                      type="button"
                      onClick={onNewRun}
                      className="rounded-[7px] px-2 py-1 text-[11px] text-text-2 underline hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
                    >
                      Run
                    </button>
                    <StarButton
                      favorited={favoriteKinds.includes(kind)}
                      kindLabel={toHumanLabel(kind)}
                      onToggle={() => toggleFavoriteKind(kind)}
                    />
                  </div>
                ))}
              </div>
            </section>
          </aside>
        )}
      </div>
    </div>,
  );
}
