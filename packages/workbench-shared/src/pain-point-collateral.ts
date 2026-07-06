import { type } from "arktype";

// Resume-boundary contracts for the pain-point-collateral workflow's five HITL
// gates (CL-2775). Both the block-driven dock surface (`blocks.ts`) and the
// run-page panel (`ui.tsx`) POST these shapes; registering them pulls each gate's
// completeness/shape invariant to the /resume boundary so a malformed payload is
// rejected with 400 instead of poisoning the downstream steps that read it.

// `note-selection`: the choice option carries the picked Granola note id. The
// `fetch` step reads `steps.select.output` into `granola_get_note`, so a
// note-less selection would fetch nothing.
export const PainPointNoteSelectionPayloadSchema = type({
  noteId: "string >= 1",
});
export type PainPointNoteSelectionPayload =
  typeof PainPointNoteSelectionPayloadSchema.infer;

// `context`: an OPTIONAL free-text note merged into the analyze step's input. A
// blank context is a valid submit (the run can proceed on the transcript alone),
// so the whole payload — and its one field — is optional.
export const PainPointContextPayloadSchema = type({
  "context?": "string",
});
export type PainPointContextPayload =
  typeof PainPointContextPayloadSchema.infer;

// `pain-point-selection`: the multiSelect field emits the picked pain-point ids
// under `selectedIds`. The UI derives the (pain point × format) cartesian product
// for the next gate from these, so at least one id must be picked (the dock form's
// `min: 1` and the panel's MAX_PAIN_POINTS guard both enforce it) — an empty
// selection would generate no collateral, so a hand-crafted empty POST is rejected.
export const PainPointSelectionPayloadSchema = type({
  selectedIds: "string[] >= 1",
});
export type PainPointSelectionPayload =
  typeof PainPointSelectionPayloadSchema.infer;

// `format-selection`: the panel pre-computes the cartesian product and posts one
// generation item per (pain point × format). This gate stays on the run-page
// panel (the dock cannot express the join), but its shape is registered so the
// panel's resume is validated at the boundary like every other gate.
export const PainPointFormatItemSchema = type({
  format: "string >= 1",
  painPointId: "string >= 1",
  painPointTitle: "string",
  painPointDetail: "string",
  severity: "string",
});
export type PainPointFormatItem = typeof PainPointFormatItemSchema.infer;

export const PainPointFormatSelectionPayloadSchema = type({
  items: PainPointFormatItemSchema.array(),
});
export type PainPointFormatSelectionPayload =
  typeof PainPointFormatSelectionPayloadSchema.infer;

// `review`: the reviewList emits the FULL approved pieces under `approvedPieces`
// plus a per-row `decisions` array. The persist map reads ONLY
// `steps.review.output.approvedPieces` (index.ts) and its argMap resolves
// `title`/`format`/`content` off each entry — so every approved piece MUST carry a
// non-empty `content` (and title/format), or the created artifact would be empty.
// Requiring that here rejects a display-fields-only payload at the boundary rather
// than persisting hollow artifacts (the fidelity contract CL-2775 guards).
//
// `decisions` is OPTIONAL: the reviewList block does emit it (CL-2759) and it is
// validated when present, but nothing downstream consumes it, so the boundary
// must not 400 a resume that carries only `approvedPieces` — it validates what
// persist actually reads, not the block's incidental shape.
export const PainPointPieceSchema = type({
  format: "string >= 1",
  title: "string >= 1",
  content: "string >= 1",
});
export type PainPointPiece = typeof PainPointPieceSchema.infer;

export const PainPointReviewDecisionSchema = type({
  format: "string",
  title: "string",
  content: "string",
  approved: "boolean",
});
export type PainPointReviewDecision =
  typeof PainPointReviewDecisionSchema.infer;

export const PainPointReviewPayloadSchema = type({
  approvedPieces: PainPointPieceSchema.array(),
  "decisions?": PainPointReviewDecisionSchema.array(),
});
export type PainPointReviewPayload = typeof PainPointReviewPayloadSchema.infer;
