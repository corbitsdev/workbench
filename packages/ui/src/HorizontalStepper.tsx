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

export default function HorizontalStepper({ steps }: HorizontalStepperProps) {
  const reduceMotion = useReducedMotion() === true;

  return (
    <div className="bg-surface border-b border-border px-6 py-5">
      <div className="flex items-center gap-2 md:gap-3">
        {steps.map((step, idx) => (
          <motion.div
            key={step.number}
            initial={reduceMotion ? false : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { delay: idx * 0.05 }}
            aria-current={step.status === "current" ? "step" : undefined}
            className="flex flex-1 items-center gap-2 md:gap-3 last:flex-none"
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

            {/* Step label */}
            <span
              className={`text-sm font-medium whitespace-nowrap ${labelClasses(step.status)}`}
            >
              {step.label}
            </span>

            {/* Connector (except last step) — filled once the phase behind it
                has actually completed, otherwise a neutral rail. */}
            {idx < steps.length - 1 && (
              <div className="h-0.5 min-w-2 flex-1 overflow-hidden rounded-full bg-border-strong">
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
        ))}
      </div>
    </div>
  );
}
