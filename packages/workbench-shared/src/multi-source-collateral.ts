import { type } from "arktype";

// Resume-boundary contracts for multi-source-collateral HITL gates (CL-4034).

export const MultiSourceArtifactItemSchema = type({
  artifactId: "string >= 1",
});
export type MultiSourceArtifactItem =
  typeof MultiSourceArtifactItemSchema.infer;

export const MultiSourceNoteItemSchema = type({
  noteId: "string >= 1",
});
export type MultiSourceNoteItem = typeof MultiSourceNoteItemSchema.infer;

export const MultiSourceIssueItemSchema = type({
  id: "string >= 1",
});
export type MultiSourceIssueItem = typeof MultiSourceIssueItemSchema.infer;

// `sources`: multi-select mix. At least one of artifactItems / noteItems /
// issueItems / non-empty text must be present — enforced by a custom check in
// the registry (arktype alone cannot express cross-field OR easily without
// unions of many shapes). Schema still requires the array fields.
export const MultiSourceSourcesPayloadSchema = type({
  artifactItems: MultiSourceArtifactItemSchema.array(),
  noteItems: MultiSourceNoteItemSchema.array(),
  issueItems: MultiSourceIssueItemSchema.array(),
  "text?": "string",
});
export type MultiSourceSourcesPayload =
  typeof MultiSourceSourcesPayloadSchema.infer;

export function multiSourceSourcesHasAtLeastOne(
  payload: MultiSourceSourcesPayload,
): boolean {
  if (payload.artifactItems.length > 0) return true;
  if (payload.noteItems.length > 0) return true;
  if (payload.issueItems.length > 0) return true;
  const text = payload.text?.trim() ?? "";
  return text.length > 0;
}

export const MultiSourceGenerateItemSchema = type({
  contentType: "string >= 1",
  sourceContext: "string >= 1",
  systemPrompt: "string",
  "titleHint?": "string",
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
});
export type MultiSourceGenerateItem =
  typeof MultiSourceGenerateItemSchema.infer;

export const MultiSourceOptionsPayloadSchema = type({
  items: MultiSourceGenerateItemSchema.array().atLeastLength(1),
});
export type MultiSourceOptionsPayload =
  typeof MultiSourceOptionsPayloadSchema.infer;

export const MultiSourcePieceSchema = type({
  format: "string >= 1",
  title: "string >= 1",
  content: "string >= 1",
});
export type MultiSourcePiece = typeof MultiSourcePieceSchema.infer;

export const MultiSourceRegenerateItemSchema = type({
  contentType: "string >= 1",
  sourceContext: "string >= 1",
  systemPrompt: "string",
  previousContent: "string >= 1",
  feedback: "string >= 1",
  "titleHint?": "string",
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
});
export type MultiSourceRegenerateItem =
  typeof MultiSourceRegenerateItemSchema.infer;

export const MultiSourceReviewPayloadSchema = type({
  approvedPieces: MultiSourcePieceSchema.array(),
  shouldRegenerate: "boolean",
  regenerateItems: MultiSourceRegenerateItemSchema.array(),
});
export type MultiSourceReviewPayload =
  typeof MultiSourceReviewPayloadSchema.infer;

export const MultiSourceReviewFinalPayloadSchema = type({
  approvedPieces: MultiSourcePieceSchema.array(),
});
export type MultiSourceReviewFinalPayload =
  typeof MultiSourceReviewFinalPayloadSchema.infer;
