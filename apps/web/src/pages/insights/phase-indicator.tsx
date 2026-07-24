import { AlertTriangle, Bell, Check, Clock } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { PulsingRing } from "@workbench/ui";
import type { LogStepState } from "../../lib/run-state-adapter";

// The exact calmed spring CL-4394 settled on for the completed-step checkmark
// pop, reused here so the operator trace lands with the same feel as the
// member-facing progress block instead of a re-tuned bounce.
const CHECK_POP_SPRING = {
  type: "spring",
  duration: 0.4,
  bounce: 0.15,
} as const;

// Per-phase status indicator: never color-only. Each phase pairs a semantic
// token WITH a distinguishing glyph. Awaiting-signal is a genuine action gate —
// the one place the accent token is warranted; passive states stay neutral.
// Shared by the step list and the trace-waterfall overview so both surfaces
// encode phase identically. In-flight is the only phase that pulses — it
// reuses the shared PulsingRing primitive (CL-4394) rather than a spinner, so
// the operator trace reads with the same motion language as the member run
// view. Terminal phases (completed/failed/awaiting/cancelled) stay static.
export function PhaseIndicator({ phase }: { phase: LogStepState["phase"] }) {
  const reduceMotion = useReducedMotion() === true;
  const base =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border";
  if (phase === "in-flight") {
    return (
      <span
        className={`${base} relative border-blue/40 bg-blue/10 text-blue`}
        aria-label="In flight"
      >
        <PulsingRing colorClassName="bg-blue/25" />
        <span className="h-2 w-2 rounded-full bg-blue" aria-hidden />
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
        <motion.span
          className="flex items-center justify-center"
          initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={CHECK_POP_SPRING}
        >
          <Check className="h-3 w-3" />
        </motion.span>
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
