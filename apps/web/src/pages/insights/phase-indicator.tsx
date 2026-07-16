import { AlertTriangle, Bell, Check, Clock, Loader2 } from "lucide-react";
import type { LogStepState } from "../../lib/run-state-adapter";

// Per-phase status indicator: never color-only. Each phase pairs a semantic
// token WITH a distinguishing glyph. Awaiting-signal is a genuine action gate —
// the one place the accent token is warranted; passive states stay neutral.
// Shared by the step list and the trace-waterfall overview so both surfaces
// encode phase identically.
export function PhaseIndicator({ phase }: { phase: LogStepState["phase"] }) {
  const base =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border";
  if (phase === "in-flight") {
    return (
      <span
        className={`${base} border-blue/40 bg-blue/10 text-blue`}
        aria-label="In flight"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (phase === "awaiting-signal") {
    return (
      <span
        className={`${base} border-accent/40 bg-accent/10 text-accent`}
        aria-label="Awaiting approval"
      >
        <Bell className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "awaiting-timer") {
    return (
      <span
        className={`${base} border-border bg-surface-2 text-text-3`}
        aria-label="Waiting"
      >
        <Clock className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "completed") {
    return (
      <span
        className={`${base} border-green/40 bg-green/10 text-green`}
        aria-label="Completed"
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span
        className={`${base} border-red/40 bg-red/10 text-red`}
        aria-label="Failed"
      >
        <AlertTriangle className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className={`${base} border-border bg-surface-2 text-text-3`}
      aria-label="Cancelled"
    >
      <span className="text-[11px] leading-none">×</span>
    </span>
  );
}
