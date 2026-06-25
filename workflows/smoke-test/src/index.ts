import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from "@workbench/agents";

// Diagnostic workflow: a single agent step, no tools, no external APIs, no
// human signal. On a manual trigger it should immediately dispatch and emit
// RunStarted -> StepStarted -> StepCompleted. Used to isolate whether the
// native workflow supervisor dispatches runs at all, independent of any tool
// (e.g. granola) or credential resolution.
const emitAgent = defineAgent({
  id: "smoke-test-emit",
  description:
    "Emits a fixed line to prove the workflow runtime dispatches a step.",
  systemPrompt: "Reply with exactly: SMOKE_TEST_OK. Output nothing else.",
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: "openai-compatible", model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = "Smoke Test";
export const description =
  "Single agent step, no tools — proves the workflow runtime dispatches a run.";
export const kind = "smoke-test";

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    emit: step({ agent: emitAgent, input: { literal: { prompt: "ping" } } }),
  },
});
