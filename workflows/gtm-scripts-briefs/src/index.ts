import { awaitSignal, defineWorkflow } from "@intx/workflow";
import {
  deterministicToolStep,
  inlineInferenceStep,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import { buildResearchSteps } from "@workbench/workflow-last30days-research";
import { buildScriptsBriefsSystemPrompt } from "./prompts";

const WRITER_MAX_TOKENS = 16384;

export const label = "GTM Scripts & Briefs";
export const description =
  "Research current stories, select a grounded angle, and turn it into a GTM script and brief artifact.";
export const kind = "gtm-scripts-briefs";

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: "intake" }),

    // Reuse the proven current-story retrieval, grounding, and curation sequence.
    ...buildResearchSteps(),

    write: inlineInferenceStep({
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

    persist: deterministicToolStep({
      id: "gtm-scripts-briefs-persist-artifact",
      title: "Save the deliverable",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
          { from: "steps.write.output" },
        ],
      },
      argMap: {
        title: { from: "topic" },
        body: { from: "reply" },
        kind: { literal: "long-form-script-package" },
        data: {
          object: {
            workflowKind: { literal: kind },
            topic: { from: "topic" },
            days: { from: "days" },
            audience: { from: "audience", optional: true },
            objective: { from: "objective", optional: true },
            artifactKind: { literal: "long-form-script-package" },
          },
        },
        jobLabel: { literal: "GTM scripts and briefs" },
      },
      after: ["write"],
    }),
  },
});
