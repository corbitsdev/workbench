import { type } from "arktype";

// Resume-boundary contract for the gamma-presentation-creator workflow's
// preview gate (CL-2730). Each `preview-N` gate parks the run waiting for the
// human's approve/refine decision; the downstream `check-N` gate branches on
// `approved`, so a payload with no boolean `approved` is not a decision — it is
// rejected at the /resume boundary rather than left to poison the branch.
//
// `feedback` is the reviewer's refine note: on a REFINE (`approved: false`) it is
// REQUIRED and non-empty (CL-2730) — the next round's `generate-N` step revises
// from it, so a refine with no guidance would blind re-roll; the /resume boundary
// rejects it rather than letting a guidance-less refine through. On an APPROVE
// (`approved: true`) no note is needed. Both the dock's choice + prompt-box path
// and the run-page panel gate refine on a non-empty note, so both deliver an
// equivalent, boundary-valid decision.
export const GammaPreviewPayloadSchema = type({
  approved: "true",
  "feedback?": "string",
}).or({
  approved: "false",
  feedback: "string >= 1",
});
export type GammaPreviewPayload = typeof GammaPreviewPayloadSchema.infer;

// Resume-boundary contract for the gamma-presentation-creator `intake` gate
// (CL-2684). The intake collects the deck brief: a title and a Gamma template
// (both REQUIRED — the render step reads `deckTitle` + `gammaId`, so a hollow
// intake would render a titleless deck off no template), the optional
// audience/tone/goal that steer the generate prompt, and an optional source
// (an artifact id, a Granola note id, or pasted text — the fetch steps are
// nonFatal, so a source-less intake still generates from the brief). Both the
// dock's block-driven form and the run-page panel POST this shape; registering
// it rejects a titleless/templateless intake at the /resume boundary rather
// than letting the render step fail deep in the run.
export const GammaIntakePayloadSchema = type({
  deckTitle: "string >= 1",
  gammaId: "string >= 1",
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
  "artifactId?": "string",
  "noteId?": "string",
  "text?": "string",
});
export type GammaIntakePayload = typeof GammaIntakePayloadSchema.infer;
