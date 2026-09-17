// Adapting the chat wire's parts (`./wire/parts`) to the shapes `@corbits/react-ui`
// renders.
//
// Only reasoning crosses this boundary now. Tool calls used to as well,
// but the conversation renders them through `tool-activity.tsx` instead:
// react-ui's `ToolBlock` shows one call at a time with its arguments and
// its result as `JSON.stringify` output, and the chat surface groups a
// turn's calls into rounds and never shows a reader JSON at all.

import type { PartReasoning } from "@corbits/react-ui";
import type { ReasoningPart } from "./wire/parts";

/** chat's reasoning carries no duration; react-ui's is optional, so it
 * stays absent rather than being fabricated. */
export function toReactUiReasoning(part: ReasoningPart): PartReasoning {
  return { kind: "reasoning", text: part.text };
}
