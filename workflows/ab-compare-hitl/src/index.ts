import { awaitSignal, defineWorkflow, map } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { AB_EXECUTE_SYSTEM_PROMPT } from "./prompts";

// -------------------------------------------------------------------------
// Human-in-the-loop A/B Test (CL-2504).
//
// The same blind execution as "A/B Test (Agent Select)", but the WINNER is
// chosen by the user, not an agent judge. There is no `compare` inference step;
// instead a `decision` signal carries the human's ranking. The compose tool
// reads that human decision (decidedBy: "human") and folds it together with the
// variant configs and outputs into the same `ab-comparison` artifact the
// agent-select workflow produces — so both render through one ComparisonView.
//
//   step        mechanism
//   ---------   --------------------------------------------------------------
//   config      awaitSignal — the panel collects provider+model per variant,
//               optional skills, and the shared input ({ variants[], input }).
//   execute     map over config.variants — one blind inline-inference turn per
//               variant.
//   decision    awaitSignal — the human reviews the (blind) variant outputs and
//               picks the winner, writing the ranking + rationale. Payload:
//               { ranking: [{ rank, label, rationale? }], summary?, recommendation? }.
//   compose     deterministicToolStep ab_comparison_compose — folds config +
//               execute + the human decision into one structured payload.
//   persist     deterministicToolStep artifact_create — saves the ab-comparison.
// -------------------------------------------------------------------------

export const label = "A/B Test - Human Select";
export const description =
  "Run a shared prompt blind across multiple provider/model variants, then let a human pick the winner and save the comparison.";
export const kind = "ab-compare-hitl";

// The persisted artifact's kind — shared with the agent-select workflow so the
// renderer routes both to the same ComparisonView.
export const ARTIFACT_KIND = "ab-comparison";

const executeStep = inlineInferenceStep({
  id: "hitl-ab-execute",
  systemPrompt: AB_EXECUTE_SYSTEM_PROMPT,
  // Inside the `execute` map the runtime rebinds `trigger.payload` to the CURRENT
  // variant record, which the execute agent reads as its JSON input. A variant
  // record carries provider/model but NOT the prompt to run — the shared prompt
  // is the top-level `config.output.input`. Merge it onto every variant so each
  // model runs on the shared prompt (CL-2684): the block-driven dock form submits
  // one shared `input` and per-variant records without their own `input`, so
  // without this thread each variant would run prompt-less. Merge order puts the
  // shared prompt last so it is authoritative even if a variant carries its own
  // (the run-page panel copies the shared prompt into each variant — same result).
  input: {
    merge: [
      { from: "trigger.payload" },
      { project: { from: "steps.config.output" }, fields: ["input"] },
    ],
  },
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Collect variants + shared input. Same payload as agent-select.
    config: awaitSignal({ name: "ab-config" }),

    // 2. Run every variant blind, one inline single-turn inference each.
    execute: map({
      over: { from: "steps.config.output.variants" },
      step: executeStep,
      after: ["config"],
    }),

    // 3. The human picks the winner. Payload carries the full ranking the
    //    compose tool reads as the (human) decision:
    //    { ranking: [{ rank, label, rationale? }], summary?, recommendation? }.
    decision: awaitSignal({ name: "ab-decision", after: ["execute"] }),

    // 4. Fold configs + outputs + the human decision into one structured
    //    comparison payload (decidedBy: "human").
    compose: deterministicToolStep({
      id: "hitl-ab-compose",
      tool: "ab_comparison_compose",
      input: { from: "steps" },
      after: ["decision"],
    }),

    // 5. Save the structured comparison as an `ab-comparison` artifact.
    persist: deterministicToolStep({
      id: "hitl-ab-persist",
      tool: "artifact_create",
      input: { from: "steps.compose.output" },
      argMap: {
        content: { from: "content" },
        title: { literal: "A/B Comparison Results" },
        kind: { literal: ARTIFACT_KIND },
      },
      after: ["compose"],
    }),
  },
});
