import { workflowRunStateStatus } from "../db/schema";

// The single source of truth for which workflow-run statuses are TERMINAL.
//
// This partition IS the CL-2575 invariant: a run parked at an awaitSignal gate
// (`awaiting`) is NOT terminal — it is resumable across a restart, and treating
// it as terminal is exactly what stranded parked runs with `reason=corrupt`
// (failing the record dropped its deployment, the repo got reaped out from under
// the resume watcher, and the resume push dangled). Encode the set ONCE here and
// reuse it everywhere a "is this run done?" / "should this deployment be torn
// down?" decision is made (the projection bridge, the reconciler, the janitor)
// so the three can never drift.
export type RunStatus = (typeof workflowRunStateStatus)[number];

// `RunCancelled` folds into `failed` in the projection (there is no `cancelled`
// status row). User stop (CL-3688) persists as `stopped`.
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "stopped",
] as const;
// `provisioning` (CL-2755) is non-terminal: a run whose per-run deployment is
// still being minted off the /start critical path has not settled — it advances
// to `running` (projection) or `failed` (start tail) — and is never a candidate
// for the terminal-teardown / reclaim path.
export const NON_TERMINAL_RUN_STATUSES = [
  "provisioning",
  "running",
  "awaiting",
] as const;

const TERMINAL_SET: ReadonlySet<RunStatus> = new Set(TERMINAL_RUN_STATUSES);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_SET.has(status);
}

// True only on a NON-terminal → terminal transition. Used to fire the per-run
// deployment teardown exactly once (CL-2582), and never on `awaiting` (the
// CL-2575 invariant): `awaiting` is non-terminal on both sides, so a run parking
// at a gate never trips this.
export function becameTerminal(prev: RunStatus, next: RunStatus): boolean {
  return !isTerminalRunStatus(prev) && isTerminalRunStatus(next);
}
