// The campaign's own conversational agent definition: a mail-triggered
// single-step agent with a per-agent system prompt, shaped exactly like
// the seeded `workflows/assistant` definition (single step, unbounded
// triggers, explicit timeout) but with the prompt as input — the seeded
// builder hardcodes its prompt, and the campaign needs distinct
// personas plus mid-campaign prompt changes (skill-marker redeploys).
//
// The declared `inference.sources` MUST equal the deploy body's
// `(provider, model)` pair: the deploy gate approves exactly the pairs
// the agent declares (vendor/intx/workflow-deploy orchestrator), and
// the sidecar rejects sources whose provider is not a registered
// adapter — so a `catalog:`-style placeholder cannot deploy through
// the public deployments route.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export interface CampaignAgentWorkflowInput {
  readonly handle: string;
  readonly tenantDomain: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly inferencePreferences: readonly InferencePreference[];
  readonly turnTimeoutMs: number;
}

export function buildCampaignAgentWorkflow(
  input: CampaignAgentWorkflowInput,
): WorkflowDefinition {
  if (input.handle === "") {
    throw new Error("buildCampaignAgentWorkflow requires a non-empty handle");
  }
  if (input.systemPrompt === "") {
    throw new Error(
      "buildCampaignAgentWorkflow requires a non-empty systemPrompt",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildCampaignAgentWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  const stepId = "agent";
  return defineWorkflow({
    id: `wf_agent_${input.handle}`,
    trigger: { type: "mail", to: `${input.handle}@${input.tenantDomain}` },
    steps: {
      [stepId]: step({
        agent: defineAgent({
          id: stepId,
          description: input.description,
          systemPrompt: input.systemPrompt,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }),
        timeout: input.turnTimeoutMs,
        triggers: "unbounded",
      }),
    },
  });
}

export function serializeCampaignAgentWorkflow(
  definition: WorkflowDefinition,
): string {
  return JSON.stringify(definition);
}
