import type { WorkflowRun } from "../hooks/use-workflow";

export type RunStatusFilter = "all" | WorkflowRun["status"];
export type RunSort = "newest" | "oldest";

export interface RunFilters {
  status: RunStatusFilter;
  kind: string;
  sort: RunSort;
  search: string;
}

export const ALL_KINDS = "all";

export const DEFAULT_RUN_FILTERS: RunFilters = {
  status: "all",
  kind: ALL_KINDS,
  sort: "newest",
  search: "",
};

/** Distinct workflow kinds present in the run list, sorted for a stable menu. */
export function distinctRunKinds(runs: readonly WorkflowRun[]): string[] {
  return [...new Set(runs.map((run) => run.kind))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function matchesFilters(run: WorkflowRun, filters: RunFilters): boolean {
  if (filters.status !== "all" && run.status !== filters.status) return false;
  if (filters.kind !== ALL_KINDS && run.kind !== filters.kind) return false;
  const query = filters.search.trim().toLowerCase();
  if (query.length > 0) {
    const haystacks = [run.kind, run.runId];
    if (!haystacks.some((field) => field.toLowerCase().includes(query))) {
      return false;
    }
  }
  return true;
}

// Sorts by createdAt; an unparseable date sorts oldest so a garbage timestamp
// never floats to the top of a newest-first list.
function createdAtMs(run: WorkflowRun): number {
  const ms = new Date(run.createdAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Applies the status/kind filter and the date sort to a run list, returning a
 * new array (never mutating the input). The runs themselves are already scoped
 * to the active tenant by the query; this is purely a client-side view filter.
 */
export function applyRunFilters(
  runs: readonly WorkflowRun[],
  filters: RunFilters,
): WorkflowRun[] {
  const filtered = runs.filter((run) => matchesFilters(run, filters));
  const direction = filters.sort === "newest" ? -1 : 1;
  return filtered
    .slice()
    .sort((a, b) => direction * (createdAtMs(a) - createdAtMs(b)));
}
