import { type } from "arktype";

// Resume-boundary contracts for the ab-compare-hitl workflow (CL-2683). Both
// gates carry a structured payload the downstream steps depend on, so the shape
// is pulled to the /resume trust boundary (see apps/hub resume-payload-registry)
// rather than trusting whatever free text reaches the gate. A blind winner-pick
// cannot be expressed as free text — it MUST carry a ranking — so a free-text
// `{ instruction }` payload is rejected here instead of folding to a hollow,
// winner-less artifact.

// One ranked variant in the human decision. `rank` 1 is the winner; `rationale`
// is the reviewer's note on that pick (optional per row).
export const AbDecisionRankingEntrySchema = type({
  rank: "number",
  label: "string",
  "rationale?": "string",
});
export type AbDecisionRankingEntry = typeof AbDecisionRankingEntrySchema.infer;

// The `ab-decision` gate payload: the human's ranked pick. A non-empty ranking
// is REQUIRED — a decision with no ranking is not a decision. `rationale` is a
// top-level convenience the dock's choice+prompt-box path sets (the compose tool
// folds it onto the rank-1 entry when the entry carries none), so the dock and
// the run-page panel produce equivalent artifacts.
export const AbDecisionPayloadSchema = type({
  ranking: AbDecisionRankingEntrySchema.array().atLeastLength(1),
  "summary?": "string",
  "recommendation?": "string",
  "rationale?": "string",
});
export type AbDecisionPayload = typeof AbDecisionPayloadSchema.infer;

// One variant slot in the `ab-config` gate payload. The execute map reads
// providerName/model/input off each; extra keys (label/systemPrompt/skillIds)
// ride along untouched.
export const AbConfigVariantSchema = type({
  "label?": "string",
  providerName: "string",
  model: "string",
  input: "string",
  "systemPrompt?": "string",
  "skillIds?": "string[]",
});
export type AbConfigVariant = typeof AbConfigVariantSchema.infer;

// The `ab-config` gate payload: at least one fully-specified variant plus the
// shared input. Rejecting an empty/instruction-only payload here stops a generic
// "Continue" affordance from posting `{ instruction: "" }` and corrupting the
// run (the execute map would fold `variants` to undefined).
export const AbConfigPayloadSchema = type({
  variants: AbConfigVariantSchema.array().atLeastLength(1),
  input: "string",
});
export type AbConfigPayload = typeof AbConfigPayloadSchema.infer;
