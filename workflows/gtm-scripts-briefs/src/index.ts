import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import { buildResearchSteps } from "@workbench/workflow-last30days-research";
import { buildScriptsBriefsSystemPrompt } from "./prompts";
import { INTAKE_FIELDS, INTAKE_SIGNAL, STEP_UI } from "./step-ui";

const WRITER_MODEL = "kimi-k2.6";
const WRITER_PROVIDER = "openai-compatible";
const WRITER_MAX_TOKENS = 16384;

// Corbits terminology guidance every reasoning step's system prompt carries,
// so the deliverable spells Corbits/Corbits.dev/Interchange/Faremeter
// consistently regardless of how the source material spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

export const label = "GTM Scripts & Briefs";
export const description =
  "Research current stories, select a grounded angle, and turn it into a GTM script and brief artifact.";
export const kind = "gtm-scripts-briefs";

const ARTIFACT_KIND = "long-form-script-package";
const JOB_LABEL = "GTM scripts and briefs";

// Native `action` handler refs — the tool's literal `<factoryId>:<bareName>`
// name, checked against the committed tool manifest by
// `packages/tool-manifest/src/resolvable-handlers.test.ts`, so a typo'd or
// manifest-drifted handler string still fails the build rather than
// deploying a step nothing can dispatch.
export const PREPARE_PERSIST_HANDLER =
  "@workbench/workflow-gtm-scripts-briefs/core:gtm_scripts_briefs_prepare_persist";
export const WRITE_ARTIFACT_HANDLER =
  "@workbench/tools-artifact/artifact:write_artifact";

// Re-export the user-facing display flow so it travels with the workflow
// package for the server catalog classifier and run panel.
export { DISPLAY_STEPS } from "./display-steps";

// Re-exported so server-side consumers (the workflow catalog, the deploy
// build) see the same declarations the dock and the schedule/attach UI use.
// `INTAKE_FIELDS` (CL-4538) is the schedule-field metadata `build-workflow-defs`
// reads via this module's `INTAKE_FIELDS` export to populate the embedded
// def's `intakeFields` — without it the Routines/attach form has nothing to
// render and the /resume boundary rejects the empty payload it collects.
export { INTAKE_FIELDS, INTAKE_SIGNAL, STEP_UI };

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: INTAKE_SIGNAL }),

    // Reuse the proven current-story retrieval, grounding, and curation sequence.
    ...buildResearchSteps(),

    // Native reasoning-with-tools step: a plain `step({ agent })` built from
    // `defineAgent` on the heavier writer model. Its title lives in `STEP_UI`
    // (dock rendering), not on an agent tag — this package carries no
    // dispatch-time UI metadata.
    write: step({
      agent: defineAgent({
        id: "gtm-scripts-briefs-write",
        description: "Reasoning step: gtm-scripts-briefs-write",
        systemPrompt: [
          CORBITS_VOCABULARY,
          buildScriptsBriefsSystemPrompt(),
        ].join("\n\n"),
        tools: [],
        capabilities: [],
        inference: {
          sources: [
            {
              provider: WRITER_PROVIDER,
              model: WRITER_MODEL,
              parameters: { maxTokens: WRITER_MAX_TOKENS },
            },
          ],
        },
      }),
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
        ],
      },
      after: ["brief"],
    }),

    // `write_artifact`'s `data` argument nests literal constants
    // (`workflowKind`, `artifactKind`, `jobLabel`) alongside intake fields
    // and the writer's `reply`. Native selectors merge whole objects but
    // cannot build a nested object from mixed literal-and-dynamic per-key
    // values, so `gtm_scripts_briefs_prepare_persist`
    // (`./tools.ts`) — a workflow-owned shaping tool mirroring
    // exa-topic-watch's `exa_topic_watch_prepare_search` — does that one
    // reshape, keeping the workflow self-contained.
    "persist-prepare": action({
      handler: PREPARE_PERSIST_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.write.output" },
          {
            literal: {
              workflowKind: kind,
              artifactKind: ARTIFACT_KIND,
              jobLabel: JOB_LABEL,
            },
          },
        ],
      },
      effect: { requires: [PREPARE_PERSIST_HANDLER] },
      after: ["write"],
    }),

    // Native `action`: `persist-prepare`'s output already carries
    // write_artifact's own argument names (`title`, `body`, `kind`, `data`,
    // `jobLabel`), so this step is a pure passthrough.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: { from: "steps.persist-prepare.output.content" },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["persist-prepare"],
    }),
  },
});
