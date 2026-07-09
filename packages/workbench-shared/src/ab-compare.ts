import { type } from "arktype";

// Resume-boundary contracts for the A/B compare preset workflows. Both gates
// carry a structured payload the downstream steps depend on, so the shape is
// pulled to the /resume trust boundary (see apps/hub resume-payload-registry)
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

// The curated-preset `ab-config` gate payload. The preset workflows fix their
// models at definition time, so the human supplies ONLY the shared prompt. A
// prompt is required: the run cannot start with nothing to compare.
export const AbPresetConfigPayloadSchema = type({
  input: "string > 0",
});
export type AbPresetConfigPayload = typeof AbPresetConfigPayloadSchema.infer;
