import { cn } from "@workbench/ui";
import {
  ArrowUpRight,
  Check,
  Hand,
  Play,
  RotateCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  shortRunId,
  type WorkflowEventState,
  type WorkflowRunEvent,
} from "../lib/run-events";
import { requestDockFocus } from "../lib/dock-focus";

// State drives both a distinct color AND a distinct glyph (design tokens from
// @workbench/ui styles.css): blue running/progress, cream needs-you, green
// done, red failed. Orange is reserved for the action affordance (the "Open in
// dock" button), never a passive status, so the passive gate-awaiting state
// uses the non-action cream/attention token — and gate-awaiting vs failed are
// told apart by icon (Hand vs TriangleAlert), not by warm hue alone.
const STATE_META: Record<
  WorkflowEventState,
  { label: string; dot: string; stripe: string; chip: string; Icon: LucideIcon }
> = {
  started: {
    label: "Started",
    dot: "bg-blue",
    stripe: "border-l-blue",
    chip: "text-blue",
    Icon: Play,
  },
  progressed: {
    label: "Progressed",
    dot: "bg-blue",
    stripe: "border-l-blue",
    chip: "text-blue",
    Icon: RotateCw,
  },
  "gate-awaiting": {
    label: "Needs you",
    dot: "bg-cream",
    stripe: "border-l-cream",
    chip: "text-cream",
    Icon: Hand,
  },
  completed: {
    label: "Done",
    dot: "bg-green",
    stripe: "border-l-green",
    chip: "text-green",
    Icon: Check,
  },
  failed: {
    label: "Failed",
    dot: "bg-red",
    stripe: "border-l-red",
    chip: "text-red",
    Icon: TriangleAlert,
  },
};

// A benign started/progressed/completed transition is announced politely; a
// failed run or a run that now needs the operator is urgent (assertive), so a
// screen reader interrupts rather than queuing it behind chatter.
function isUrgent(state: WorkflowEventState): boolean {
  return state === "failed" || state === "gate-awaiting";
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

/**
 * A workflow event in Myra's thread (CL-2682), rendered as its OWN bubble —
 * visibly NOT Myra's voice. It carries no avatar/prose styling; it is a centered
 * system strip that names the run it belongs to (kind + short id) so two
 * concurrent runs never blur, and links "Open in dock" to surface that run's
 * card. A gate-awaiting event reads "needs your input" against the named run,
 * pairing with the multi-gate disambiguation rule (CL-2681).
 */
export function WorkflowEventBubble({ event }: { event: WorkflowRunEvent }) {
  const meta = STATE_META[event.state];
  const urgent = isUrgent(event.state);

  return (
    <div className="flex w-full justify-center" data-role="workflow-event">
      <div
        data-testid="workflow-event-bubble"
        data-run-id={event.runId}
        data-state={event.state}
        role={urgent ? "alert" : "status"}
        aria-live={urgent ? "assertive" : "polite"}
        className={cn(
          "flex max-w-[90%] items-center gap-2 rounded-md border border-border border-l-2 bg-surface-2 px-3 py-1.5 text-xs",
          meta.stripe,
        )}
      >
        <meta.Icon
          size={13}
          className={cn("shrink-0", meta.chip)}
          aria-hidden
        />
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)}
          aria-hidden
        />
        <span className="min-w-0 text-text-2">
          <span className={cn("font-medium", meta.chip)}>{meta.label}</span>
          {" · "}
          <span className="font-medium text-text">{event.kind}</span>
          <span className="text-text-3">{` · ${shortRunId(event.runId)}`}</span>
          <span className="block truncate text-text-3">{event.summary}</span>
        </span>
        <button
          type="button"
          onClick={() => requestDockFocus(event.runId)}
          aria-label={`Open ${event.kind} ${shortRunId(event.runId)} in dock`}
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md border border-orange px-1.5 py-0.5 text-orange hover:bg-orange hover:text-white",
            FOCUS_RING,
          )}
        >
          Open in dock
          <ArrowUpRight size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
