import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { AB_COMPARE_SYSTEM_PROMPT, AB_EXECUTE_SYSTEM_PROMPT } from "./prompts";

// `execute` and `compare` are pure single-turn reasoning steps: each returns
// content/JSON directly and never calls a tool (the deterministic `persist`
// step does the artifact creation). Both run as inline-inference steps
// (CL-2251): the sidecar runs them in-process with a bare `createAgent` and the
// hub deploys no per-step session. See the steps below — there are no longer
// execute/compare defineAgents.

export const label = "A/B Compare";
export const description =
  "Run two content variants through a blind comparison and surface ranked results.";
export const kind = "ab-compare";

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Step 1: collect the shared prompt from the user.
    // Payload: { prompt: string }
    input: awaitSignal({ name: "input" }),

    // Step 2: execute the prompt (single-agent — no map; dynamic multi-variant
    // fan-out requires a runtime array selector that the substrate does not yet
    // expose from an awaitSignal payload). Inline single-turn inference
    // (CL-2251): no tools, so no per-step session. The agent receives the raw
    // signal payload and produces output for blind ranking.
    execute: inlineInferenceStep({
      id: "blind-ab-execute",
      systemPrompt: AB_EXECUTE_SYSTEM_PROMPT,
      input: { from: "steps.input.output" },
      after: ["input"],
    }),

    // Step 3: blind-rank the execution output. Inline single-turn inference
    // (CL-2251): no tools, returns strict JSON.
    compare: inlineInferenceStep({
      id: "blind-ab-compare",
      systemPrompt: AB_COMPARE_SYSTEM_PROMPT,
      input: { from: "steps.execute.output" },
      after: ["execute"],
    }),

    // Step 4: human reviews the ranking and approves.
    // Payload: { approved: true }
    review: awaitSignal({ name: "comparison-review", after: ["compare"] }),

    // Step 5: deterministic artifact_create — saves the comparison result.
    // The compare agent's `reply` (strict JSON) becomes the artifact content.
    persist: deterministicToolStep({
      id: "blind-ab-persist",
      tool: "artifact_create",
      input: { from: "steps.compare.output" },
      argMap: {
        content: { from: "reply" },
        title: { literal: "A/B Comparison Results" },
        kind: { literal: "document" },
      },
      after: ["review"],
    }),
  },
});
