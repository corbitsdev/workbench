import type { StepsBlockData } from "@corbits/chat/blocks";

import { BlockCard } from "./block-card";

export function StepsBlockView({ data }: { readonly data: StepsBlockData }) {
  return (
    <BlockCard title={data.title}>
      <div className="chat-block-steps">
        {data.steps.map((step, index) => (
          <div
            key={`${index}-${step.label}`}
            className="chat-block-step"
            data-state={step.state}
          >
            <span className="chat-block-step-dot" aria-hidden="true" />
            <span>{step.label}</span>
            {step.note !== undefined && (
              <span className="chat-block-step-note">{step.note}</span>
            )}
          </div>
        ))}
      </div>
    </BlockCard>
  );
}
