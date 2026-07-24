import { StatusDot } from "@workbench/ui";

// CL-2755: the live "Starting…" state for a run whose per-run deployment is still
// cold-starting (`provisioning`). This is a HARD product requirement — a
// provisioning run must never look frozen — so the indicator always carries
// visible motion. The motion is the shared PulsingRing primitive (CL-4394)
// via StatusDot, matching the "starting" vocabulary used by WorkflowDock,
// SubagentDock, and ActiveWorkflowRuns (blue, pulsing) instead of a
// hand-rolled spinner/animate-pulse pair. StatusDot's base dot is always
// rendered, so the indicator carries a static fallback under reduced motion.
interface WorkflowStartingIndicatorProps {
  // "pane" fills a run pane/console; "compact" fits inside a dock card row.
  variant?: "pane" | "compact";
  label?: string;
}

export function WorkflowStartingIndicator({
  variant = "pane",
  label = "Starting…",
}: WorkflowStartingIndicatorProps) {
  const compact = variant === "compact";
  const dotSize: "xs" | "sm" = compact ? "xs" : "sm";
  const container = compact
    ? "flex items-center gap-2"
    : "flex h-full flex-col items-center justify-center gap-3 border border-border bg-bg";
  const textSize = compact ? "text-xs text-text-3" : "text-[13px] text-text-2";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="workflow-starting-indicator"
      className={container}
    >
      <span data-testid="workflow-starting-spinner">
        <StatusDot colorClassName="bg-blue" pulsing size={dotSize} />
      </span>
      <p className={textSize}>{label}</p>
      <span className="sr-only">Workflow run is starting</span>
    </div>
  );
}
