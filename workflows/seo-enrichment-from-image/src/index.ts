import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { SEO_ENRICH_SYSTEM_PROMPT } from "./prompts";

// `enrich` is a pure single-turn reasoning step: it reads the intake signal
// (image URL, page URL, metadata) supplied inline and returns strict JSON of
// SEO variants. It never reads an artifact — the declared `artifact_read`
// capability was vestigial; the deterministic `persist` step writes the result.
// It runs as an inline-inference step (CL-2251): the sidecar runs it in-process
// with a bare `createAgent` and the hub deploys no per-step session.

export const label = "SEO Enrichment from Image";
export const description =
  "Extract SEO metadata from a product image and enrich a target page URL.";
export const kind = "seo-enrichment-from-image";

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: "intake" }),
    enrich: inlineInferenceStep({
      id: "seo-enrich",
      systemPrompt: SEO_ENRICH_SYSTEM_PROMPT,
      input: { from: "steps.intake.output" },
      after: ["intake"],
    }),
    review: awaitSignal({ name: "row-selection", after: ["enrich"] }),
    persist: deterministicToolStep({
      id: "seo-enrich-persist",
      tool: "artifact_create",
      input: { from: "steps.review.output" },
      argMap: {
        content: { from: "selectedIds" },
        title: { literal: "SEO Enrichment Results" },
        kind: { literal: "document" },
      },
      after: ["review"],
    }),
  },
});
