import { defineWorkflow } from '@intx/workflow';
import { inlineInferenceStep, PERSONAL_AGENT_DEPLOY_PROMPT } from '@workbench/agents';

// Staging spike: one shared workflow deployment, one ephemeral createAgent turn per
// user message (CL-2251 inline inference). Does not replace per-user Myra instances.

const SPIKE_INPUT_GUIDE = `
Each turn you receive JSON (trigger payload) with:
- message: the user's latest message (string)
- history: optional array of { role: "user" | "assistant", content: string } for prior turns

Respond to message using history when present. This path has no long-lived harness workspace;
do not assume files from a prior session unless the client included them in the payload.
`;

export const label = 'Myra (ephemeral spike)';
export const description =
  'Labs spike: Myra-style prompt via inline workflow inference — no per-user instance session.';
export const kind = 'myra-ephemeral-spike';

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: 'manual' },
  steps: {
    chat: inlineInferenceStep({
      id: 'myra-ephemeral-spike-chat',
      systemPrompt: `${PERSONAL_AGENT_DEPLOY_PROMPT}\n\n${SPIKE_INPUT_GUIDE}`,
      input: { from: 'trigger.payload' },
      ephemeralChat: 'v1',
    }),
  },
});