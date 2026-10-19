// Renders an agent's reasoning and tool-call trace parts through react-ui's
// native disclosure primitives.
import { ReasoningBlock, ToolBlock, type ToolBlockState } from "@corbits/react-ui";

import type { TracePart } from "./run-traces";
import type { ToolTracePart } from "./wire/parts";

function toToolBlockState(part: ToolTracePart): ToolBlockState {
  const output =
    typeof part.output === "string"
      ? part.output
      : part.output === undefined
        ? ""
        : JSON.stringify(part.output);
  switch (part.status) {
    case "pending":
      return { status: "pending" };
    case "running":
      return { status: "running" };
    case "success":
      return { status: "output-available", output };
    case "error":
      return { status: "error", message: output };
    default: {
      part.status satisfies never;
      return { status: "pending" };
    }
  }
}

export function TracePartsList({
  parts,
  streamingReasoningIndex = null,
}: {
  readonly parts: readonly TracePart[];
  readonly streamingReasoningIndex?: number | null;
}) {
  if (parts.length === 0) return null;
  return (
    <div className="chat-thread-traces">
      {parts.map((part, index) => {
        if (part.kind === "reasoning") {
          return (
            <ReasoningBlock
              key={`r:${String(index)}`}
              text={part.text}
              streaming={streamingReasoningIndex === index}
            />
          );
        }
        return (
          <ToolBlock
            key={`t:${String(index)}:${part.name}`}
            name={part.name}
            state={toToolBlockState(part)}
            input={part.input}
          />
        );
      })}
    </div>
  );
}
