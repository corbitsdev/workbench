import { type } from "arktype";

// Resume-boundary contracts for multi-source-collateral HITL gates.
//
// Native-primitives cutover: every gate is now a data-driven `form`/
// `reviewList` UIBlock built by the workflow's own tools (see that package's
// `tools.ts`/`step-ui.ts`), so the resume payload shapes are the generic
// dock-block submit shapes (`multiSelect` → `string[]`, `reviewList` →
// `{ approvedPieces, decisions }`) rather than the former workflow-specific
// `{ artifactItems, noteItems, issueItems, text }` / `{ items }` shapes.

// `sources`: a `form` block submit — a multiSelect of "artifact:<id>" /
// "note:<id>" / "issue:<id>" values plus an optional free-text field. At
// least one selected source or non-empty free text must be present —
// enforced by a custom check in the registry (arktype alone cannot express
// cross-field OR easily without unions of many shapes).
export const MultiSourceSourcesPayloadSchema = type({
  sourceIds: "string[]",
  "freeText?": "string",
});
export type MultiSourceSourcesPayload =
  typeof MultiSourceSourcesPayloadSchema.infer;

export function multiSourceSourcesHasAtLeastOne(
  payload: MultiSourceSourcesPayload,
): boolean {
  if (payload.sourceIds.length > 0) return true;
  const text = payload.freeText?.trim() ?? "";
  return text.length > 0;
}

// `options`: a `form` block submit — the multiSelect of picked content types
// plus the optional per-run guidance fields.
export const MultiSourceOptionsPayloadSchema = type({
  contentTypes: type("string").array().atLeastLength(1),
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
  "titleHint?": "string",
  "promptOverride?": "string",
});
export type MultiSourceOptionsPayload =
  typeof MultiSourceOptionsPayloadSchema.infer;

export const MultiSourcePieceSchema = type({
  format: "string >= 1",
  title: "string >= 1",
  content: "string >= 1",
});
export type MultiSourcePiece = typeof MultiSourcePieceSchema.infer;

// `review` / `review-final`: a `reviewList` block submit — every row's
// verdict (`decisions`, covering every row) plus the approved rows' payloads
// (`approvedPieces`). `review-final` carries only `approvedPieces` (a final
// review has no further regenerate path).
export const MultiSourceDecisionSchema = type({
  approved: "boolean",
  format: "string >= 1",
  title: "string >= 1",
  content: "string >= 1",
});
export type MultiSourceDecision = typeof MultiSourceDecisionSchema.infer;

export const MultiSourceReviewPayloadSchema = type({
  approvedPieces: MultiSourcePieceSchema.array(),
  decisions: MultiSourceDecisionSchema.array(),
});
export type MultiSourceReviewPayload =
  typeof MultiSourceReviewPayloadSchema.infer;

export const MultiSourceReviewFinalPayloadSchema = type({
  approvedPieces: MultiSourcePieceSchema.array(),
});
export type MultiSourceReviewFinalPayload =
  typeof MultiSourceReviewFinalPayloadSchema.infer;
