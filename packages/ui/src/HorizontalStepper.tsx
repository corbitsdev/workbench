import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import PulsingRing from "./PulsingRing";
import { type WorkflowStep } from "./workflow-step-types";

interface HorizontalStepperProps {
  steps: WorkflowStep[];
}

// The connecting rail segment AFTER a phase pill: filled once that phase is
// actually completed, so the flowing highlight never runs ahead of real work
// (mirrors the substep timeline's rail-fill rule, CL-4394).
function segmentFilled(status: WorkflowStep["status"]): boolean {
  return status === "completed";
}

function pillClasses(status: WorkflowStep["status"]): string {
  if (status === "completed") return "bg-green text-white";
  if (status === "failed") return "bg-red text-white";
  if (status === "current") return "bg-blue text-white";
  return "bg-surface-2 text-text-3";
}

function labelClasses(status: WorkflowStep["status"]): string {
  if (status === "current") return "text-text";
  if (status === "failed") return "text-red";
  if (status === "completed") return "text-text-2";
  return "text-text-3";
}

function pillGlyph(status: WorkflowStep["status"], number: number): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  return String(number);
}

// Above this many steps, an even split can't give every label readable room
// (pill + connector alone approach the per-step budget), so labels compress to
// numbers-only pills except for the current step — the one label a user
// actually needs to see without scrolling. Every label still renders (as
// `sr-only`) so screen readers and DOM assertions see the full step list.
const LABEL_VISIBLE_STEP_THRESHOLD = 5;

// In compressed mode only the current step shows a label, so it needs most of
// the row's flexible width; the rest just need enough to hold their fixed-size
// pill + connector. An 8:1 grow ratio hands the current step the lion's share
// without starving its neighbors down to negative/zero space.
function itemFlexStyle(
  isLast: boolean,
  isCurrent: boolean,
  compress: boolean,
): { flex: string } | undefined {
  if (isLast) return undefined; // last:flex-initial class handles this item
  if (!compress) return undefined; // flex-1 class handles the uncompressed case
  return { flex: isCurrent ? "8 1 0%" : "1 1 0%" };
}

export default function HorizontalStepper({ steps }: HorizontalStepperProps) {
  const reduceMotion = useReducedMotion() === true;
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const compress = steps.length > LABEL_VISIBLE_STEP_THRESHOLD;

  // Safety net for the rare case where even fully-compressed steps don't fit
  // (e.g. 10+ steps on a narrow viewport): the rail becomes horizontally
  // scrollable (edge-fade below signals there's more), and the current step
  // is always scrolled into view without any user interaction.
  useEffect(() => {
    currentRef.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [steps]);

  return (
    <div className="bg-surface border-b border-border px-6 py-5">
      <div
        ref={scrollRef}
        className="flex items-center gap-2 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)] md:gap-3"
      >
        {steps.map((step, idx) => {
          const flexStyle = itemFlexStyle(
            idx === steps.length - 1,
            step.status === "current",
            compress,
          );
          return (
            <motion.div
              key={step.number}
              ref={step.status === "current" ? currentRef : undefined}
              initial={reduceMotion ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduceMotion ? { duration: 0 } : { delay: idx * 0.05 }
              }
              aria-current={step.status === "current" ? "step" : undefined}
              {...(flexStyle !== undefined ? { style: flexStyle } : {})}
              className="flex min-w-0 flex-1 items-center gap-2 last:flex-initial md:gap-3"
            >
              {/* Step indicator */}
              <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                {step.status === "current" && (
                  <PulsingRing
                    colorClassName="bg-blue/30"
                    reduceMotion={reduceMotion}
                  />
                )}
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors duration-300 ${pillClasses(step.status)}`}
                >
                  {pillGlyph(step.status, step.number)}
                </div>
              </div>

              {/* Step label — grows to claim any space the fixed-width pill and
                connector don't need, then truncates instead of forcing the
                rail to overflow; `title` keeps the full text reachable on
                hover/focus. Past LABEL_VISIBLE_STEP_THRESHOLD steps, only the
                current step's label stays on screen (others go `sr-only`) so
                the numbers-only pills for the rest actually have room. */}
              <span
                title={step.label}
                className={
                  compress && step.status !== "current"
                    ? "sr-only"
                    : `min-w-0 flex-1 truncate text-sm font-medium ${labelClasses(step.status)}`
                }
              >
                {step.label}
              </span>

              {/* Connector (except last step) — a fixed-width decorative rail
                (not flex-1) so it never competes with the label for space;
                filled once the phase behind it has actually completed,
                otherwise a neutral rail. */}
              {idx < steps.length - 1 && (
                <div
                  className={`h-0.5 shrink-0 overflow-hidden rounded-full bg-border-strong ${compress ? "min-w-2 flex-1" : "w-4 md:w-6"}`}
                >
                  <motion.div
                    data-filled={segmentFilled(step.status)}
                    className="h-full w-full origin-left rounded-full bg-green"
                    initial={false}
                    animate={{
                      scaleX: segmentFilled(step.status) ? 1 : 0,
                    }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                  />
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
