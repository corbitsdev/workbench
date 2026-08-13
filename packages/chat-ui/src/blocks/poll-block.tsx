// Poll choices render without percentages: tallies come from stored
// responses once the round-trip lands, never from agent-authored numbers.

import type { PollBlockData } from "@corbits/chat/blocks";

import { BlockCard } from "./block-card";

export function PollBlockView({ data }: { readonly data: PollBlockData }) {
  return (
    <BlockCard title={data.title}>
      <div className="chat-block-choices">
        {data.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="chat-block-choice"
            disabled
          >
            {choice.label}
          </button>
        ))}
      </div>
    </BlockCard>
  );
}
