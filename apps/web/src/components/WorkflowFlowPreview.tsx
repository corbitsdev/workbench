import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { WorkflowFlowStep } from "@workbench/shared";

const STEP_KIND_LABEL: Record<WorkflowFlowStep["kind"], string> = {
  auto: "Automated",
  agent: "AI agent",
  human: "Your input",
};

const STEP_CHIP_CLASS: Record<WorkflowFlowStep["kind"], string> = {
  auto: "border-border bg-surface-2",
  agent: "border-blue/40 bg-blue/5",
  human: "border-orange/50 bg-[rgba(233,132,40,0.08)]",
};

const STEP_NODE_CLASS: Record<WorkflowFlowStep["kind"], string> = {
  auto: "border-border bg-surface text-text-3",
  agent: "border-blue/40 bg-blue/10 text-blue",
  human: "border-orange/50 bg-[rgba(233,132,40,0.12)] text-orange-deep",
};

const STEP_BADGE_CLASS: Record<WorkflowFlowStep["kind"], string> = {
  auto: "text-text-3",
  agent: "text-blue",
  human: "text-orange-deep",
};

const STEP_GLYPH: Record<WorkflowFlowStep["kind"], string> = {
  auto: "●",
  agent: "◆",
  human: "★",
};

const LEGEND: WorkflowFlowStep["kind"][] = ["auto", "agent", "human"];

// The step-flow diagram. Steps flow left-to-right, top-to-bottom in a compact
// responsive grid; the number on each chip carries the run order so a wide,
// short layout still reads as a sequence. Selecting a workflow re-keys the grid
// so the chips stagger in. Under prefers-reduced-motion the chips appear at rest.
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
      transition: { staggerChildren: reduceMotion ? 0 : 0.03 },
    },
  };
  const item: Variants = reduceMotion
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 6 },
        show: {
          opacity: 1,
          y: 0,
          transition: { type: "spring", stiffness: 460, damping: 32 },
        },
      };

  return (
    <div className="flex flex-col gap-3">
      <motion.ol
        key={animationKey}
        className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {steps.map((step, index) => (
          <motion.li
            key={step.id}
            variants={item}
            className={`flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2 ${STEP_CHIP_CLASS[step.kind]}`}
          >
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border text-[10px] font-bold tabular-nums ${STEP_NODE_CLASS[step.kind]}`}
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] font-semibold leading-tight text-text">
                {step.title}
              </span>
              <span
                className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.04em] ${STEP_BADGE_CLASS[step.kind]}`}
              >
                <span aria-hidden="true">{STEP_GLYPH[step.kind]}</span>
                {STEP_KIND_LABEL[step.kind]}
              </span>
            </div>
          </motion.li>
        ))}
      </motion.ol>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {LEGEND.map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`grid h-4 w-4 place-items-center rounded-[5px] border text-[9px] ${STEP_NODE_CLASS[kind]}`}
            >
              {STEP_GLYPH[kind]}
            </span>
            {STEP_KIND_LABEL[kind]}
          </span>
        ))}
      </div>
    </div>
  );
}
