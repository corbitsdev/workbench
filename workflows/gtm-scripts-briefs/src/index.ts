import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import {
  agentStep,
  canonicalizeStepToolName,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import { buildResearchSteps } from "@workbench/workflow-last30days-research";
import { buildScriptsBriefsSystemPrompt } from "./prompts";
import { INTAKE_FIELDS, INTAKE_SIGNAL, STEP_UI } from "./step-ui";

const WRITER_MAX_TOKENS = 16384;

export const label = "GTM Scripts & Briefs";
export const description =
  "Research current stories, select a grounded angle, and turn it into a GTM script and brief artifact.";
export const kind = "gtm-scripts-briefs";

const ARTIFACT_KIND = "long-form-script-package";
const JOB_LABEL = "GTM scripts and briefs";

// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, resolved via `canonicalizeStepToolName`'s build-time-checked
// lookup, so a typo'd or manifest-drifted tool name fails the build instead
// of deploying a step nothing can dispatch.
export const PREPARE_PERSIST_HANDLER = canonicalizeStepToolName(
  "gtm-scripts-briefs-prepare-persist",
  "gtm_scripts_briefs_prepare_persist",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "gtm-scripts-briefs-persist-artifact",
  "write_artifact",
);

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

    write: agentStep({
      id: "gtm-scripts-briefs-write",
      title: "Write the deliverable",
      systemPrompt: buildScriptsBriefsSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: WRITER_MAX_TOKENS,
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
    // (`@workbench/workflow-gtm-scripts-briefs`) — a workflow-owned shaping
    // tool mirroring exa-topic-watch's `exa_topic_watch_prepare_search` —
    // does that one reshape, keeping the workflow self-contained.
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
