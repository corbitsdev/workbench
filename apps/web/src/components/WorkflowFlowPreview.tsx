import type { WorkflowFlowStep } from "@workbench/shared";
import {
  StepGraph,
  stepGraphKindGlyph,
  stepGraphKindLabel,
  type StepGraphKind,
} from "@workbench/ui";

const STEP_NODE_CLASS: Record<StepGraphKind, string> = {
  auto: "border-border bg-surface text-text-3",
  agent: "border-blue/40 bg-blue/10 text-blue",
  human: "border-orange/50 bg-[rgba(233,132,40,0.12)] text-orange-deep",
};

const LEGEND: StepGraphKind[] = ["auto", "agent", "human"];

/** Catalog workflow preview: compact step graph plus kind legend. */
export function WorkflowFlowPreview({
  steps,
  animationKey,
}: {
  steps: readonly WorkflowFlowStep[];
  animationKey: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <StepGraph
        steps={steps}
        density="compact"
        animationKey={animationKey}
      />

      {steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {LEGEND.map((kind) => (
            <span key={kind} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`grid h-4 w-4 place-items-center rounded-[5px] border text-[9px] ${STEP_NODE_CLASS[kind]}`}
              >
                {stepGraphKindGlyph[kind]}
              </span>
              {stepGraphKindLabel[kind]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}