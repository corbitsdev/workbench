// Only reasoning crosses this boundary now — tool calls render through
// `tool-activity.tsx` instead, since react-ui's `ToolBlock` shows raw JSON.

import type { PartReasoning } from "@corbits/react-ui";
import type { ReasoningPart } from "./wire/parts";

/** chat's reasoning carries no duration; react-ui's is optional, so it
 * stays absent rather than being fabricated. */
export function toReactUiReasoning(part: ReasoningPart): PartReasoning {
  return { kind: "reasoning", text: part.text };
}
