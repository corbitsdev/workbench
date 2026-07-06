import type { ConversationWorkflowRun } from "../hooks/use-workflow";

type RunStatus = ConversationWorkflowRun["status"];

// The run-addressed workflow event vocabulary (CL-2682). Derived client-side
// from the coarse status the conversation-run list already polls — there is no
// separate backend event stream. `started`/`progressed`/`gate-awaiting`/
// `completed`/`failed` are the transitions observable from the list projection.
export type WorkflowEventState =
  | "started"
  | "progressed"
  | "gate-awaiting"
  | "completed"
  | "failed";

// One event, addressed to exactly one run (kind + runId + state + summary), so
// two concurrent runs never blur: every bubble names the run it belongs to.
// `at` is the ISO instant the transition was observed, used to interleave the
// event into the chat thread in timeline order alongside messages.
export interface WorkflowRunEvent {
  id: string;
  runId: string;
  kind: string;
  state: WorkflowEventState;
  summary: string;
  at: string;
}

function summaryFor(state: WorkflowEventState, kind: string): string {
  switch (state) {
    case "started":
      return `Started ${kind}`;
    case "progressed":
      return `${kind} picked back up`;
    case "gate-awaiting":
      return `${kind} needs your input`;
    case "completed":
      return `${kind} finished`;
    case "failed":
      return `${kind} failed`;
  }
}

// The single transition (if any) a run's status change produces. `previous` is
// undefined for a run observed for the first time.
function transitionState(
  previous: RunStatus | undefined,
  next: RunStatus,
): WorkflowEventState | null {
  if (previous === next) return null;

  if (next === "completed") return "completed";
  if (next === "failed") return "failed";
  if (next === "awaiting") return "gate-awaiting";

  // next === "running"
  if (previous === undefined) return "started";
  if (previous === "awaiting") return "progressed";
  // running from a terminal state cannot happen in the list projection; treat
  // any other arrival at running as a fresh start.
  return "started";
}

export interface RunEventDerivation {
  events: WorkflowRunEvent[];
  next: Map<string, RunStatus>;
  counter: number;
}

export interface DeriveRunEventsInput {
  previous: Map<string, RunStatus>;
  runs: readonly ConversationWorkflowRun[];
  now: string;
  counter: number;
  /**
   * The first observation of a conversation's runs seeds the baseline without
   * emitting: a page load must not replay a "started…finished" history for runs
   * that already ran. Events accrue only for transitions seen live thereafter.
   */
  seed: boolean;
}

// Pure fold from the previous per-run status map + the latest poll to the new
// events and updated baseline. Kept pure so the transition rules are unit
// testable without React or timers.
export function deriveRunEvents({
  previous,
  runs,
  now,
  counter,
  seed,
}: DeriveRunEventsInput): RunEventDerivation {
  const next = new Map<string, RunStatus>();
  const events: WorkflowRunEvent[] = [];
  let nextCounter = counter;

  // `next` is rebuilt from the current runs each poll, so a run that transiently
  // drops out of the list and later reappears has no prior status and re-emits
  // `started`. We accept this: archived/terminal runs do not return to the list,
  // so in practice only a poll/pagination flap could trigger it.
  for (const run of runs) {
    next.set(run.runId, run.status);
    if (seed) continue;

    const state = transitionState(previous.get(run.runId), run.status);
    if (state === null) continue;

    events.push({
      id: `${run.runId}:${nextCounter}`,
      runId: run.runId,
      kind: run.kind,
      state,
      summary: summaryFor(state, run.kind),
      at: now,
    });
    nextCounter += 1;
  }

  return { events, next, counter: nextCounter };
}

// A run id is a constant 4-char prefix + 32 hex chars; a 10-char slice kept
// only ~6 hex chars of entropy, so two concurrent runs could show the same
// label. Keep 16 chars (12 hex of entropy, ~2^48) so the label is stable-unique
// per run within a conversation while staying short.
export function shortRunId(runId: string): string {
  return runId.length > 16 ? `${runId.slice(0, 16)}…` : runId;
}
