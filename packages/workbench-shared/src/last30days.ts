import { type } from "arktype";

// Resume-boundary contract for the last30days-research workflow's `intake` gate
// (CL-2765). The gate collects what to research: a `topic` (REQUIRED and
// non-empty — every downstream source query and the report title derive from it,
// so a blank topic would ground the whole scan on nothing) and an optional
// `focus` (the angle to emphasize). Both the block-driven `form` UIBlock and the
// run-page panel POST this shape; registering it rejects a topic-less intake at
// the /resume boundary rather than letting the grounding/collect steps throw deep
// in the run.
//
// The block form emits `{ topic, focus }` verbatim, so the panel's former
// client-side `query = focus || topic` / `days: 30` derivation is NOT in this
// payload — it now lives server-side in `normalizeIntake`
// (@workbench/last30days-core), the single place the pipeline derives the
// canonical `{ topic, query, days }`. The legacy panel additionally sends the
// derived `query`/`days`; they are accepted (optional) so the strangler-fallback
// path stays valid.
export const Last30daysIntakePayloadSchema = type({
  topic: "string >= 1",
  "focus?": "string",
  "query?": "string",
  "days?": "number",
});
export type Last30daysIntakePayload =
  typeof Last30daysIntakePayloadSchema.infer;
