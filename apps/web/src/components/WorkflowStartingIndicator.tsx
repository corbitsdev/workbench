import { cn } from "@workbench/ui";

// CL-2755: the live "Starting…" state for a run whose per-run deployment is still
// cold-starting (`provisioning`). This is a HARD product requirement — a
// provisioning run must never look frozen — so the indicator always carries
// visible motion (an animated spinner; the animated dots are a secondary cue).
// `motion-reduce:animate-none` respects the OS reduced-motion preference; the
// dots remain as a non-animated fallback there.
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
  const spinnerSize = compact ? "h-3 w-3" : "h-5 w-5";
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
      <span
        data-testid="workflow-starting-spinner"
        aria-hidden
        className={cn(
          "shrink-0 animate-spin rounded-full border-2 border-border border-t-blue motion-reduce:animate-none",
          spinnerSize,
        )}
      />
      <p className={textSize}>
        {label}
        <span className="animate-pulse motion-reduce:animate-none" aria-hidden>
          {" "}
          ·
        </span>
      </p>
      <span className="sr-only">Workflow run is starting</span>
    </div>
  );
}
