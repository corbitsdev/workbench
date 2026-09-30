// The smallest mail-triggered workflow: one step, no tools. Bundled by the
// install test into the source tree it installs.
import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export function buildEchoWorkflow(input: {
  triggerAddress: string;
  inferencePreferences: readonly InferencePreference[];
}): WorkflowDefinition {
  return defineWorkflow({
    id: "echo",
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      echo: step({
        agent: {
          id: "echo",
          description: "Replies with the text it received",
          systemPrompt: "Reply with the exact text of the message you received.",
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: [],
        } satisfies AgentDefinition,
        triggers: "unbounded",
      }),
    },
  });
}
