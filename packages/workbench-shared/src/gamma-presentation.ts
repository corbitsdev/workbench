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
