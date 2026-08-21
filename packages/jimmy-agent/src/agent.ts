// Jimmy's agent definition: the portable half described in
// `corbitsdev/examples`' agent-quickstart — a system prompt and a tool
// declaration, no credentials, no storage. A host binds this to a real
// Giphy credential and deploys it; this file only says what Jimmy *is*.
//
// Ported from `scout/packages/jimmy/src/index.ts`'s `jimmyPackage`: this
// keeps the one-shot "search Giphy, reply with a GIF" behavior and drops
// everything Slack-specific — the `/gif` slash command, the 4-up picker,
// and the shuffle/cancel signal machine (`scout/workflows/jimmy`). See
// this package's README for what that leaves deferred.
import type { AgentDefinition, InferencePreference } from "@intx/agent";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { GIF_SEARCH_TOOL } from "./gif-search-tool";

export const JIMMY_AGENT_ID = "jimmy";

/** This definition pins itself: the package that carries `gif_search` is this one. */
export const JIMMY_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/jimmy-agent", version: "0.0.1" },
];

export const JIMMY_SYSTEM_PROMPT =
  "You are Jimmy. Someone mentions you in chat with a request for a GIF " +
  `— call \`${GIF_SEARCH_TOOL}\` with their words as the search query and ` +
  "reply with the GIF it finds.\n" +
  "\n" +
  "Call the tool exactly once per request, with a short, literal query " +
  "drawn from what they asked for — do not embellish or add unrelated " +
  "terms. Reply with the CDN URL the tool returns so the chat renders " +
  "the GIF; do not describe the GIF instead of showing it, and never " +
  "download, re-host, or link anywhere other than the returned URL.\n" +
  "\n" +
  "If the tool comes back telling you Giphy is not connected, say that " +
  "plainly in one sentence and stop — never invent a GIF, a URL, or a " +
  "description in its place. If the search finds nothing, say so and " +
  "suggest the requester try different words.\n" +
  "\n" +
  "You are a one-shot responder, not a conversation: one request, one " +
  "reply, no follow-up picker.";

export interface BuildJimmyAgentInput {
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
}

/** Builds Jimmy's `AgentDefinition` — the shape every installable agent
 * in this catalog authors against (see `@corbits/code-review-workflow`). */
export function buildJimmyAgent(input: BuildJimmyAgentInput): AgentDefinition {
  return {
    id: JIMMY_AGENT_ID,
    description: "Searches Giphy and replies with a GIF",
    systemPrompt: JIMMY_SYSTEM_PROMPT,
    toolFactories: [],
    capabilities: [],
    inference: { sources: input.inferencePreferences },
    toolPackagePins: JIMMY_TOOL_PACKAGE_PINS,
  } satisfies AgentDefinition;
}
