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

import {
  GIF_SEARCH_TOOL,
  JIMMY_AGENT_ID,
  JIMMY_SYSTEM_PROMPT,
  JIMMY_TOOL_PACKAGE_PINS,
} from "./metadata";

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
