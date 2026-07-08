import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { WorkflowFlowStep } from "@workbench/shared";

const STEP_KIND_LABEL: Record<WorkflowFlowStep["kind"], string> = {
  auto: "Automated",
  agent: "AI agent",
  human: "Your input",
};

const STEP_NODE_CLASS: Record<WorkflowFlowStep["kind"], string> = {
  auto: "border-border bg-surface-2 text-text-3",
  agent: "border-blue/40 bg-blue/10 text-blue",
  human: "border-orange/50 bg-[rgba(233,132,40,0.12)] text-orange-deep",
};

const STEP_BADGE_CLASS: Record<WorkflowFlowStep["kind"], string> = {
  auto: "bg-surface-2 text-text-3",
  agent: "bg-blue/10 text-blue",
  human: "bg-[rgba(233,132,40,0.12)] text-orange-deep",
};

const STEP_GLYPH: Record<WorkflowFlowStep["kind"], string> = {
  auto: "●",
  agent: "◆",
  human: "★",
};

// The step-flow diagram. Selecting a workflow re-keys the list so the steps
// stagger/spring in top-to-bottom and a pulse travels the spine to convey flow
// direction. Under prefers-reduced-motion the steps appear at rest and the pulse
// is omitted — the same information, no movement.
export function WorkflowFlowPreview({
  steps,
  animationKey,
}: {
  steps: readonly WorkflowFlowStep[];
  animationKey: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;

  if (steps.length === 0) {
    return (
      <p className="text-[13px] text-text-3">
        This workflow has no preview available. You can still run it.
      </p>
    );
  }

  const container: Variants = {
    hidden: {},
    show: {
      transition: { staggerChildren: reduceMotion ? 0 : 0.07 },
    },
  };
  const item: Variants = reduceMotion
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 8 },
        show: {
          opacity: 1,
          y: 0,
          transition: { type: "spring", stiffness: 420, damping: 30 },
        },
      };

  return (
    <motion.ol
      key={animationKey}
      className="relative flex flex-col gap-3 py-1 pl-1"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <span
        aria-hidden="true"
        className="absolute bottom-4 left-5 top-4 w-px -translate-x-1/2 bg-border"
      />
      {!reduceMotion && (
        <motion.span
          aria-hidden="true"
          className="absolute left-5 h-2 w-2 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent-soft)]"
          initial={{ top: "0%", opacity: 0 }}
          animate={{ top: ["2%", "98%"], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {steps.map((step) => (
        <motion.li
          key={step.id}
          variants={item}
          className="relative flex items-start gap-3"
        >
          <span
            aria-hidden="true"
            className={`z-10 grid h-8 w-8 shrink-0 place-items-center rounded-[9px] border text-[11px] font-bold ${STEP_NODE_CLASS[step.kind]}`}
          >
            {STEP_GLYPH[step.kind]}
          </span>
          <div className="min-w-0 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-text">
                {step.title}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] ${STEP_BADGE_CLASS[step.kind]}`}
              >
                {STEP_KIND_LABEL[step.kind]}
              </span>
            </div>
          </div>
        </motion.li>
      ))}
    </motion.ol>
  );
}
