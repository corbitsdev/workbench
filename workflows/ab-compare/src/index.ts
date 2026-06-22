import { awaitSignal, defineWorkflow, map } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { AB_COMPARE_SYSTEM_PROMPT, AB_EXECUTE_SYSTEM_PROMPT } from "./prompts";

// -------------------------------------------------------------------------
// Blind A/B Comparison — native restore of the pre-M6 workflow (CL-2255).
//
// Pre-M6 stages (packages/gtm-workflows/src/blind-ab-comparison, commit
// 3c4e7ae8) and how they map onto this native graph:
//
//   pre-M6 step        restored step      mechanism
//   ----------------   ----------------   ---------------------------------
//   providers          config             awaitSignal — the panel collects
//   configure          config             provider+model for each variant,
//   input              config             an optional skill, and the shared
//                                          input in ONE config signal whose
//                                          payload is { variants[], input }.
//   execute            execute            map over config.output.variants —
//                                          one blind inline-inference turn
//                                          per variant (CL-2245 proved
//                                          map.over reads a signal-payload
//                                          array directly).
//   compare            compare            inlineInferenceStep blind-ranks the
//                                          collected variant outputs.
//   feedback           review             awaitSignal — human reviews the
//                                          ranking and approves.
//   persist            persist            deterministicToolStep artifact_create.
//
// `execute` and `compare` are pure single-turn reasoning steps: they never
// call a tool, so both run as inline-inference steps (CL-2251) — the sidecar
// runs them in-process with a bare `createAgent` and the hub deploys no
// per-step session. The deterministic `persist` step does the artifact write.
// -------------------------------------------------------------------------

export const label = "A/B Compare";
export const description =
  "Run a shared prompt blind across multiple provider/model variants, rank the outputs, and save the comparison.";
export const kind = "ab-compare";

// One blind execution turn per variant. `map` passes each variant as
// `trigger.payload` ({ label, providerName, model, systemPrompt?, skill?,
// input }); the inline agent answers without ever being told it is one arm of
// a comparison.
const executeStep = inlineInferenceStep({
  id: "blind-ab-execute",
  systemPrompt: AB_EXECUTE_SYSTEM_PROMPT,
  input: { from: "trigger.payload" },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Collect the full setup in one signal: the variants (provider + model
    //    + optional skill + optional per-variant instruction) and the shared
    //    input. Payload: { variants: Array<{ label, providerName, model,
    //    systemPrompt?, skill?, input }>, input: string }. The panel injects
    //    the shared `input` onto each variant so the map'd execute step gets a
    //    self-contained payload.
    config: awaitSignal({ name: "ab-config" }),

    // 2. Run every variant blind. Each iteration is an inline single-turn
    //    inference (CL-2251): no tools, no per-step session. (The v1 map
    //    runtime iterates sequentially; the semantics are correct, only the
    //    concurrency differs — same deviation noted in pain-point-collateral.)
    execute: map({
      over: { from: "steps.config.output.variants" },
      step: executeStep,
      after: ["config"],
    }),

    // 3. Blind-rank the collected variant outputs. Inline single-turn
    //    inference: no tools, returns strict JSON. Input is the map output (an
    //    array of per-variant { reply } objects).
    compare: inlineInferenceStep({
      id: "blind-ab-compare",
      systemPrompt: AB_COMPARE_SYSTEM_PROMPT,
      input: { from: "steps.execute.output" },
      after: ["execute"],
    }),

    // 4. Human reviews the ranking and approves. Payload: { approved: true }.
    review: awaitSignal({ name: "comparison-review", after: ["compare"] }),

    // 5. Save the comparison result. The compare agent's strict-JSON `reply`
    //    becomes the artifact content.
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
