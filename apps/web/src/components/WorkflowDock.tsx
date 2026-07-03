import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import {
  UIBlockView,
  dockRunBlocks,
  DockRunPhaseSchema,
  type DockRunPhase,
} from "@workbench/chat";
import { cn, failedRunError } from "@workbench/ui";
import {
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  useConversationWorkflowRuns,
  useWorkflowRunState,
  type ConversationWorkflowRun,
} from "../hooks/use-workflow";
import type { RunRecord } from "../lib/run-state-adapter";

type RunStatus = ConversationWorkflowRun["status"];

// Attention sort: needs-you first, then running, then finished.
const ATTENTION_ORDER: Record<RunStatus, number> = {
  awaiting: 0,
  running: 1,
  failed: 2,
  completed: 3,
};

// State is the only color in this surface: blue running, amber needs-you,
// green done, red failed (design tokens from @workbench/ui styles.css).
const STATUS_META: Record<
  RunStatus,
  { label: string; dot: string; stripe: string; chip: string }
> = {
  awaiting: {
    label: "Needs you",
    dot: "bg-orange",
    stripe: "border-l-orange",
    chip: "text-orange",
  },
  running: {
    label: "Running",
    dot: "bg-blue",
    stripe: "border-l-blue",
    chip: "text-blue",
  },
  completed: {
    label: "Done",
    dot: "bg-green",
    stripe: "border-l-green",
    chip: "text-green",
  },
  failed: {
    label: "Failed",
    dot: "bg-red",
    stripe: "border-l-red",
    chip: "text-red",
  },
};

function fallbackPhase(status: RunStatus): DockRunPhase {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 12)}…` : runId;
}

function WorkflowDockCard({
  run,
  tenantId,
}: {
  run: ConversationWorkflowRun;
  tenantId?: string | null;
}) {
  const {
    data: log,
    isPending,
    isError,
  } = useWorkflowRunState(run.runId, tenantId);
  // Finished runs collapse to their one-line summary by default.
  const [open, setOpen] = useState(() => !isRecordTerminal(run.status));

  const record: RunRecord = {
    runId: run.runId,
    kind: run.kind,
    status: run.status,
  };
  const state = useMemo(
    () =>
      log !== undefined
        ? reconcileRunState(record, runStateFromLog(log))
        : null,
    [log, run.runId, run.kind, run.status],
  );
  const phase: DockRunPhase =
    state !== null && DockRunPhaseSchema.allows(state.phase)
      ? state.phase
      : fallbackPhase(run.status);
  const sanitizedError = failedRunError(state)?.userMessage;

  const blocks = useMemo(
    () =>
      dockRunBlocks({
        runId: run.runId,
        phase,
        steps: (log?.steps ?? []).map((step) => ({
          stepId: step.stepId,
          phase: step.phase,
        })),
        ...(sanitizedError !== undefined
          ? { errorMessage: sanitizedError }
          : {}),
        ...(phase === "completed"
          ? {
              completedLink: {
                url: `/workflows/${run.runId}`,
                title: "View results",
                description: "Outputs and artifacts on the run page",
              },
            }
          : {}),
      }),
    [run.runId, phase, log, sanitizedError],
  );

  const meta = STATUS_META[run.status];

  return (
    <div
      data-testid="workflow-dock-card"
      className={cn(
        "rounded-lg border border-border border-l-2 bg-surface-2",
        meta.stripe,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          data-testid="dock-card-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-text">
              {run.kind}
            </span>
            <span className="block truncate text-xs text-text-3">
              <span className={cn("font-medium", meta.chip)}>{meta.label}</span>
              {" · "}
              {shortRunId(run.runId)}
            </span>
          </span>
        </button>
        <Link
          to={`/workflows/${run.runId}`}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-row-hover hover:text-text"
        >
          Open
        </Link>
      </div>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {isPending && (
            <p className="text-xs text-text-3">Loading run progress…</p>
          )}
          {isError && (
            <p className="text-xs text-text-3">
              Couldn't load this run's progress. It may still be starting up.
            </p>
          )}
          {!isPending && !isError && blocks.length === 0 && (
            <p className="text-xs text-text-3">Waiting for the first step…</p>
          )}
          {blocks.map((block, index) => (
            <UIBlockView key={index} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface WorkflowDockProps {
  /** The open conversation (Myra thread instance id); null when none is open. */
  conversationId: string | null;
  tenantId?: string | null;
}

/**
 * Live workflow dock beside the chat (CL-2680). Absent — not an empty state —
 * until the conversation has an active run; once seen active it stays for the
 * rest of the mount so completions remain visible. Collapsible to a thin rail
 * that keeps the count and a state dot per run.
 */
export function WorkflowDock({ conversationId, tenantId }: WorkflowDockProps) {
  const { data: runs } = useConversationWorkflowRuns(conversationId, tenantId);
  const [collapsed, setCollapsed] = useState(false);
  const [sawActive, setSawActive] = useState(false);

  // Failed runs count as needing attention: hiding a failure on reload would
  // bury it. Only a conversation whose runs are all completed loads dock-less.
  const hasActive = (runs ?? []).some((run) => run.status !== "completed");
  useEffect(() => {
    if (hasActive) setSawActive(true);
  }, [hasActive]);
  useEffect(() => {
    setSawActive(false);
  }, [conversationId]);

  const sorted = useMemo(
    () =>
      [...(runs ?? [])].sort((a, b) => {
        const byAttention =
          ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status];
        if (byAttention !== 0) return byAttention;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [runs],
  );

  if (sorted.length === 0 || (!hasActive && !sawActive)) return null;

  if (collapsed) {
    return (
      <aside
        aria-label="Workflow dock"
        className="flex h-full w-10 shrink-0 flex-col items-center gap-3 border-l border-border bg-surface py-3"
      >
        <button
          type="button"
          aria-label="Expand workflow dock"
          onClick={() => setCollapsed(false)}
          className="flex flex-col items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-2 hover:bg-row-hover hover:text-text"
        >
          <ChevronsLeft size={14} aria-hidden />
          {sorted.length}
        </button>
        <div className="flex flex-col items-center gap-1.5">
          {sorted.map((run) => (
            <span
              key={run.runId}
              data-testid="dock-rail-dot"
              title={`${run.kind}: ${STATUS_META[run.status].label}`}
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_META[run.status].dot,
              )}
            />
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Workflow dock"
      className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-text">Workflows</span>
        <button
          type="button"
          aria-label="Collapse workflow dock"
          onClick={() => setCollapsed(true)}
          className="rounded-md p-1 text-text-3 hover:bg-row-hover hover:text-text"
        >
          <ChevronsRight size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {sorted.map((run) => (
          <WorkflowDockCard key={run.runId} run={run} tenantId={tenantId} />
        ))}
      </div>
    </aside>
  );
}
