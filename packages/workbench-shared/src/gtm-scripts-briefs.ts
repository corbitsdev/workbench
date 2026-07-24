import { type } from "arktype";

const NonEmptyText = type("string").narrow((value) => value.trim().length > 0);
const ResearchDays = type("number").narrow(
  (value) => Number.isInteger(value) && value > 0,
);

// The workflow accepts a research topic and window, then grounds its artifact in
// current retrieved evidence rather than user-pasted source material.
export const GtmScriptsBriefsIntakePayloadSchema = type({
  topic: NonEmptyText,
  days: ResearchDays,
  "audience?": "string",
  "objective?": "string",
});
export type GtmScriptsBriefsIntakePayload =
  typeof GtmScriptsBriefsIntakePayloadSchema.infer;

// Stored alongside the generated artifact so the selected current-story window
// and optional framing remain inspectable after the workflow run has completed.
export const GtmScriptsBriefsArtifactLineageSchema = type({
  workflowKind: "'gtm-scripts-briefs'",
  topic: NonEmptyText,
  days: ResearchDays,
  "audience?": "string",
  "objective?": "string",
  artifactKind: "'long-form-script-package'",
});
export type GtmScriptsBriefsArtifactLineage =
  typeof GtmScriptsBriefsArtifactLineageSchema.infer;
