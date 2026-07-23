import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
} from "lucide-react";
import {
  UIBlockView,
  DockRunPhaseSchema,
  type DockRunPhase,
  type UIResponse,
} from "@workbench/blocks";
import { buildDockBlocks } from "../lib/dock-block-builders";
import { resolveResumePayload } from "../lib/resume-payload";
import { stepOutputsFromLog } from "../lib/run-state-adapter";
import { WorkflowStartingIndicator } from "./WorkflowStartingIndicator";
import { cn, failedRunError } from "@workbench/ui";
import {
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  useConversationWorkflowRuns,
  useResumeConversationGate,
  useStopWorkflowRun,
  useWorkflowRunState,
  type ConversationWorkflowRun,
} from "../hooks/use-workflow";
import type { RunRecord } from "../lib/run-state-adapter";

type RunStatus = ConversationWorkflowRun["status"];

// Attention sort: needs-you first, then running/starting, then finished.
const ATTENTION_ORDER: Record<RunStatus, number> = {
  awaiting: 0,
  running: 1,
  // CL-2755: a starting run sits with the active (running) runs.
  provisioning: 1,
  failed: 2,
  completed: 3,
  stopped: 4,
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
  // The actively-working state carries live motion too (CL-2755, emil) so a
  // running run never reads deader than a pre-flight `provisioning` one.
  running: {
    label: "Running",
    dot: "bg-blue animate-pulse motion-reduce:animate-none",
    stripe: "border-l-blue",
    chip: "text-blue",
  },
  // CL-2755: the run's deployment is still cold-starting. `animate-pulse` on the
  // dot gives the collapsed rail visible motion so a starting run never reads as
  // frozen.
  provisioning: {
    label: "Starting",
    dot: "bg-blue animate-pulse motion-reduce:animate-none",
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
  stopped: {
    label: "Stopped",
    dot: "bg-text-3",
    stripe: "border-l-border",
    chip: "text-text-3",
  },
};

function fallbackPhase(status: RunStatus): DockRunPhase {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped") return "cancelled";
  // `provisioning` (CL-2755) has no log yet — treat it as the live `running`
  // phase for the dock-block fallback; the card body renders a Starting state.
  return "running";
}

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 12)}…` : runId;
}

// Keep the dock scannable: only the most attention-worthy runs get cards; the
// rest are one link away on the Workflows page.
const MAX_DOCK_CARDS = 10;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

// Per-conversation UI prefs, following the app's storage pattern
// (use-myra-threads.ts): localStorage for the collapse pref (survives reloads),
// sessionStorage for dismissed failed runs (hidden for the session only).
type DockVariant = "dock" | "popup";

function collapseKey(conversationId: string, variant: DockVariant): string {
  const suffix = variant === "popup" ? ":popup" : "";
  return `workflow-dock-collapsed:${conversationId}${suffix}`;
}

function dismissKey(conversationId: string): string {
  return `workflow-dock-dismissed:${conversationId}`;
}

// The popup surface is small, so it opens collapsed by default; the side dock
// opens expanded. An explicit stored pref always wins over the default.
function readCollapsed(
  conversationId: string | null,
  variant: DockVariant,
): boolean {
  const fallback = variant === "popup";
  if (!conversationId) return fallback;
  try {
    const stored = localStorage.getItem(collapseKey(conversationId, variant));
    if (stored === "1") return true;
    if (stored === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeCollapsed(
  conversationId: string | null,
  variant: DockVariant,
  collapsed: boolean,
) {
  if (!conversationId) return;
  try {
    localStorage.setItem(
      collapseKey(conversationId, variant),
      collapsed ? "1" : "0",
    );
  } catch {
    // storage unavailable
  }
}

function readDismissed(conversationId: string | null): string[] {
  if (!conversationId) return [];
  try {
    const raw = sessionStorage.getItem(dismissKey(conversationId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(conversationId: string | null, runIds: string[]) {
  if (!conversationId) return;
  try {
    sessionStorage.setItem(dismissKey(conversationId), JSON.stringify(runIds));
  } catch {
    // storage unavailable
  }
}

// Per-state counts in attention order, e.g. "1 awaiting, 2 running" — the
// collapsed rail's text alternative to its color-only dots.
function stateCountSummary(runs: readonly ConversationWorkflowRun[]): string {
  const order: RunStatus[] = [
    "awaiting",
    "provisioning",
    "running",
    "failed",
    "completed",
    "stopped",
  ];
  const parts: string[] = [];
  for (const status of order) {
    const count = runs.filter((run) => run.status === status).length;
    if (count > 0) parts.push(`${count} ${status}`);
  }
  return parts.join(", ");
}

function WorkflowDockCard({
  run,
  tenantId,
  onDismiss,
}: {
  run: ConversationWorkflowRun;
  tenantId?: string | null;
  onDismiss?: (runId: string) => void;
}) {
  const {
    data: log,
    isPending,
    isError,
  } = useWorkflowRunState(run.runId, tenantId);
  const resumeGate = useResumeConversationGate(tenantId);
  const stopRun = useStopWorkflowRun(tenantId);
  // Finished runs collapse to their one-line summary by default.
  const [open, setOpen] = useState(() => !isRecordTerminal(run.status));
  // Two-tap confirm for Stop (same pattern as Insights Archive).
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stopping = stopRun.isPending && stopRun.variables === run.runId;
  const canStop = !isRecordTerminal(run.status);

  // A gate choice block carries its `awaitSignal` name (CL-2681); selecting it
  // resumes THIS run with that signal + the option value as payload. The
  // in-flight mutation is the double-fire guard — the ChoiceBlock disables after
  // a click and a second click while pending is ignored. A non-gate choice (no
  // signalName) is ignored here.
  const onRespond = (response: UIResponse): void | Promise<void> => {
    if (response.signalName === undefined) return;
    if (resumeGate.isPending) return;
    // Return the mutation promise so the interactive block awaits it and shows
    // its own inline pending/error, keeping the user's input on failure
    // (CL-2684). A rejection propagates to the block — it is not swallowed here.
    return resumeGate
      .mutateAsync({
        runId: run.runId,
        signalName: response.signalName,
        // The shared block-resume contract (CL-2684): a structured payload
        // (form field map, typed choice, multiSelect array) resumes verbatim; a
        // plain choice or free text wraps the value as an instruction.
        payload: resolveResumePayload(response),
      })
      .then(() => undefined);
  };

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
      buildDockBlocks(run.kind, {
        runId: run.runId,
        phase,
        surface: "dock",
        steps: (log?.steps ?? []).map((step) => ({
          stepId: step.stepId,
          phase: step.phase,
          ...(step.awaitingSignalName !== undefined
            ? { awaitingSignalName: step.awaitingSignalName }
            : {}),
          ...(step.lastError !== undefined
            ? { lastError: step.lastError }
            : {}),
        })),
        stepOutputs: log !== undefined ? stepOutputsFromLog(log) : {},
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
    [run.runId, run.kind, phase, log, sanitizedError],
  );

  const meta = STATUS_META[run.status];

  return (
    <div
      data-testid="workflow-dock-card"
      onMouseLeave={() => {
        if (!stopping) setConfirmingStop(false);
      }}
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
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left",
            FOCUS_RING,
          )}
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
          className={cn(
            "shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-text-2 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          Open
        </Link>
        {canStop &&
          (confirmingStop ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-testid="dock-stop-confirm"
                disabled={stopping}
                onClick={() => {
                  stopRun.mutate(run.runId);
                }}
                aria-label={`Confirm: stop ${run.kind} run`}
                className={cn(
                  "rounded-md bg-red-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                {stopping ? "Stopping…" : "Confirm stop"}
              </button>
              <button
                type="button"
                disabled={stopping}
                onClick={() => setConfirmingStop(false)}
                aria-label={`Cancel stopping ${run.kind} run`}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-xs text-text-3 hover:bg-row-hover hover:text-text",
                  FOCUS_RING,
                )}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="dock-stop"
              disabled={stopping}
              onClick={() => setConfirmingStop(true)}
              title="Stop this run — leaves it in history as Stopped"
              aria-label={`Stop ${run.kind} run`}
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-xs text-text-3 hover:bg-row-hover hover:text-text disabled:opacity-50",
                FOCUS_RING,
              )}
            >
              Stop
            </button>
          ))}
        {(run.status === "failed" || run.status === "stopped") &&
          onDismiss !== undefined && (
            <button
              type="button"
              aria-label={`Dismiss ${run.kind}`}
              onClick={() => onDismiss(run.runId)}
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-xs text-text-3 hover:bg-row-hover hover:text-text",
                FOCUS_RING,
              )}
            >
              Dismiss
            </button>
          )}
      </div>
      {stopRun.isError && (
        <p
          role="alert"
          data-testid="dock-stop-error"
          className="px-3 pb-2 text-xs text-red-500"
        >
          Couldn't stop this run. Try again.
        </p>
      )}
      {open && (
        <div
          role="status"
          aria-live="polite"
          className="space-y-2 border-t border-border px-3 py-2.5"
        >
          {run.status === "provisioning" && (
            <WorkflowStartingIndicator variant="compact" />
          )}
          {run.status !== "provisioning" && isPending && (
            <p className="text-xs text-text-3">Loading run progress…</p>
          )}
          {run.status !== "provisioning" && isError && (
            <p className="text-xs text-text-3">
              Couldn't load this run's progress. It may still be starting up.
            </p>
          )}
          {run.status !== "provisioning" &&
            !isPending &&
            !isError &&
            blocks.length === 0 && (
              <p className="text-xs text-text-3">Waiting for the first step…</p>
            )}
          {run.status !== "provisioning" &&
            blocks.map((block, index) => (
              <UIBlockView key={index} block={block} onRespond={onRespond} />
            ))}
        </div>
      )}
    </div>
  );
}

export interface WorkflowDockProps {
  /**
   * The open conversation's Myra thread id; null when none is open.
   * conversationId == Myra thread id — producers (workflow_start tool,
   * chat-initiated starts) stamp the same id as originConversationId.
   */
  conversationId: string | null;
  tenantId?: string | null;
  /**
   * "dock" (default) is the side rail beside the full-page chat; "popup" is the
   * compact top strip inside the floating/docked Myra chat (CL-2685), which
   * opens collapsed given its small surface.
   */
  variant?: DockVariant;
}

/**
 * Live workflow dock beside the chat (CL-2680). Absent — not an empty state —
 * until the conversation has an active run; once seen active it stays for the
 * rest of the mount so completions remain visible. Collapsible to a thin rail
 * that keeps the count and a state dot per run.
 */
export function WorkflowDock({
  conversationId,
  tenantId,
  variant = "dock",
}: WorkflowDockProps) {
  const { data: runs } = useConversationWorkflowRuns(conversationId, tenantId);
  const [collapsed, setCollapsedState] = useState(() =>
    readCollapsed(conversationId, variant),
  );
  const [dismissed, setDismissed] = useState<string[]>(() =>
    readDismissed(conversationId),
  );
  const [sawActive, setSawActive] = useState(false);

  // Failed runs count as needing attention: hiding a failure on reload would
  // bury it. Only a conversation whose runs are all completed or user-stopped
  // loads dock-less. A dismissed failed/stopped run no longer counts — the user
  // has acknowledged it.
  const visibleRuns = useMemo(
    () => (runs ?? []).filter((run) => !dismissed.includes(run.runId)),
    [runs, dismissed],
  );
  const hasActive = visibleRuns.some(
    (run) => run.status !== "completed" && run.status !== "stopped",
  );
  useEffect(() => {
    if (hasActive) setSawActive(true);
  }, [hasActive]);
  useEffect(() => {
    setSawActive(false);
    setCollapsedState(readCollapsed(conversationId, variant));
    setDismissed(readDismissed(conversationId));
  }, [conversationId, variant]);

  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    writeCollapsed(conversationId, variant, value);
  };

  const dismissRun = (runId: string) => {
    setDismissed((previous) => {
      const next = [...previous, runId];
      writeDismissed(conversationId, next);
      return next;
    });
  };

  const sorted = useMemo(
    () =>
      [...visibleRuns].sort((a, b) => {
        const byAttention =
          ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status];
        if (byAttention !== 0) return byAttention;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [visibleRuns],
  );

  if (sorted.length === 0 || (!hasActive && !sawActive)) return null;

  const isPopup = variant === "popup";

  if (collapsed && isPopup) {
    return (
      <aside
        aria-label="Workflow dock"
        className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5"
      >
        <button
          type="button"
          aria-label={`Expand workflows: ${stateCountSummary(sorted)}`}
          onClick={() => setCollapsed(false)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-text-2 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          <ChevronDown size={14} aria-hidden />
          Workflows
          <span className="rounded-full bg-surface-2 px-1.5 text-text-3">
            {sorted.length}
          </span>
        </button>
        <div className="flex flex-1 items-center gap-1.5">
          {sorted.map((run) => (
            <span
              key={run.runId}
              data-testid="dock-rail-dot"
              title={`${run.kind}: ${STATUS_META[run.status].label}`}
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_META[run.status].dot,
              )}
            >
              <span className="sr-only">
                {`${run.kind}: ${STATUS_META[run.status].label}`}
              </span>
            </span>
          ))}
        </div>
      </aside>
    );
  }

  if (isPopup) {
    return (
      <aside
        aria-label="Workflow dock"
        className="flex max-h-56 shrink-0 flex-col border-b border-border bg-surface"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs font-semibold text-text">Workflows</span>
          <button
            type="button"
            aria-label="Collapse workflow dock"
            onClick={() => setCollapsed(true)}
            className={cn(
              "rounded-md p-1 text-text-3 hover:bg-row-hover hover:text-text",
              FOCUS_RING,
            )}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {sorted.slice(0, MAX_DOCK_CARDS).map((run) => (
            <WorkflowDockCard
              key={run.runId}
              run={run}
              tenantId={tenantId}
              onDismiss={dismissRun}
            />
          ))}
          {sorted.length > MAX_DOCK_CARDS && (
            <Link
              to="/workflows"
              className={cn(
                "block rounded-md px-2 py-1.5 text-xs text-text-2 hover:bg-row-hover hover:text-text",
                FOCUS_RING,
              )}
            >
              {sorted.length - MAX_DOCK_CARDS} more — open Workflows
            </Link>
          )}
        </div>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <aside
        aria-label="Workflow dock"
        className="flex h-full w-10 shrink-0 flex-col items-center gap-3 border-l border-border bg-surface py-3"
      >
        <button
          type="button"
          aria-label={`Expand workflows: ${stateCountSummary(sorted)}`}
          onClick={() => setCollapsed(false)}
          className={cn(
            "flex flex-col items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-2 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
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
            >
              <span className="sr-only">
                {`${run.kind}: ${STATUS_META[run.status].label}`}
              </span>
            </span>
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
          className={cn(
            "rounded-md p-1 text-text-3 hover:bg-row-hover hover:text-text",
            FOCUS_RING,
          )}
        >
          <ChevronsRight size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {sorted.slice(0, MAX_DOCK_CARDS).map((run) => (
          <WorkflowDockCard
            key={run.runId}
            run={run}
            tenantId={tenantId}
            onDismiss={dismissRun}
          />
        ))}
        {sorted.length > MAX_DOCK_CARDS && (
          <Link
            to="/workflows"
            className={cn(
              "block rounded-md px-2 py-1.5 text-xs text-text-2 hover:bg-row-hover hover:text-text",
              FOCUS_RING,
            )}
          >
            {sorted.length - MAX_DOCK_CARDS} more — open Workflows
          </Link>
        )}
      </div>
    </aside>
  );
}
