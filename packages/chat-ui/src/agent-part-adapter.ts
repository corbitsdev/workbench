// Adapting `@corbits/chat`'s parts to the shapes `@corbits/react-ui`
// renders (CL-6318).
//
// The two unions agree on their kinds — text, reasoning, tool-trace,
// block, file — because react-ui's was built against this wire. They do
// not agree on the tool-call status enum: chat's has four states,
// react-ui's has six, adding `approval-requested` and `output-denied`.
// Those two have no chat equivalent today (an approval rides as a `block`
// part bound to the real approvals flow, not as a tool status), so nothing
// here maps onto them — a gap to close upstream-first if the wire ever
// grows them, never by inventing a status the server never sent.

import type {
  PartReasoning,
  PartToolTrace,
  ToolTraceStatus,
} from "@corbits/react-ui";
import type { ReasoningPart, ToolTracePart } from "@corbits/chat/parts";

/** chat's `success` is react-ui's `output-available` — the same state
 * under the name that says what it carries. The rest are identical. */
export function toReactUiToolTrace(
  part: ToolTracePart,
  /** react-ui keys tool calls by id; chat's wire carries none, so the
   * caller passes its own message-scoped key rather than an invented id
   * that could collide across messages. */
  toolCallId = "",
): PartToolTrace {
  const status: ToolTraceStatus =
    part.status === "success" ? "output-available" : part.status;
  const base = {
    kind: "tool-trace" as const,
    toolCallId,
    name: part.name,
    status,
    input: part.input,
  };
  return part.output !== undefined ? { ...base, output: part.output } : base;
}

/** chat's reasoning carries no duration; react-ui's is optional, so it
 * stays absent rather than being fabricated. */
export function toReactUiReasoning(part: ReasoningPart): PartReasoning {
  return { kind: "reasoning", text: part.text };
}
