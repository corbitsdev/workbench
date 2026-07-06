import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  PainPointContextPayloadSchema,
  PainPointNoteSelectionPayloadSchema,
  PainPointPieceSchema,
  PainPointReviewPayloadSchema,
  PainPointSelectionPayloadSchema,
} from "./pain-point-collateral";

const ok = (schema: (v: unknown) => unknown, v: unknown) =>
  !(schema(v) instanceof type.errors);

describe("pain-point-collateral boundary schemas (CL-2775)", () => {
  test("note-selection requires a non-empty noteId", () => {
    expect(ok(PainPointNoteSelectionPayloadSchema, { noteId: "note_1" })).toBe(
      true,
    );
    expect(ok(PainPointNoteSelectionPayloadSchema, { noteId: "" })).toBe(false);
  });

  test("context is optional and must be a string when present", () => {
    expect(ok(PainPointContextPayloadSchema, {})).toBe(true);
    expect(ok(PainPointContextPayloadSchema, { context: "x" })).toBe(true);
    expect(ok(PainPointContextPayloadSchema, { context: 1 })).toBe(false);
  });

  test("selection requires a non-empty selectedIds array", () => {
    expect(ok(PainPointSelectionPayloadSchema, { selectedIds: ["a"] })).toBe(
      true,
    );
    // An empty selection generates no collateral — rejected at the edge, matching
    // the dock form's min:1 and the panel's guard (CL-2775).
    expect(ok(PainPointSelectionPayloadSchema, { selectedIds: [] })).toBe(
      false,
    );
    expect(ok(PainPointSelectionPayloadSchema, {})).toBe(false);
  });

  test("a piece requires non-empty format/title/content (fidelity guard)", () => {
    expect(
      ok(PainPointPieceSchema, { format: "email", title: "T", content: "C" }),
    ).toBe(true);
    // A content-less (display-fields-only) piece is rejected — the persist argMap
    // reads content, so an empty-content piece would persist a hollow artifact.
    expect(
      ok(PainPointPieceSchema, { format: "email", title: "T", content: "" }),
    ).toBe(false);
    expect(ok(PainPointPieceSchema, { format: "email", title: "T" })).toBe(
      false,
    );
  });

  test("review accepts full pieces and empty arrays, rejects hollow content", () => {
    expect(
      ok(PainPointReviewPayloadSchema, {
        approvedPieces: [{ format: "email", title: "T", content: "C" }],
        decisions: [
          { format: "email", title: "T", content: "C", approved: true },
        ],
      }),
    ).toBe(true);
    expect(
      ok(PainPointReviewPayloadSchema, { approvedPieces: [], decisions: [] }),
    ).toBe(true);
    expect(
      ok(PainPointReviewPayloadSchema, {
        approvedPieces: [{ format: "email", title: "T", content: "" }],
        decisions: [],
      }),
    ).toBe(false);
  });

  test("review decisions is optional — persist reads only approvedPieces", () => {
    // Nothing downstream consumes `decisions`; the boundary must not 400 a resume
    // that carries only approvedPieces (CL-2775).
    expect(
      ok(PainPointReviewPayloadSchema, {
        approvedPieces: [{ format: "email", title: "T", content: "C" }],
      }),
    ).toBe(true);
    // When present, it is still validated — a non-boolean `approved` is rejected.
    expect(
      ok(PainPointReviewPayloadSchema, {
        approvedPieces: [{ format: "email", title: "T", content: "C" }],
        decisions: [{ format: "email", title: "T", content: "C" }],
      }),
    ).toBe(false);
  });
});
