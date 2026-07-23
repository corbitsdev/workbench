import { describe, expect, test } from "bun:test";
import { STEP_ARGMAP_TAG } from "@workbench/agents";
import {
  buildPainPointCollateralBlocks,
  CONTEXT_SIGNAL,
  FORMAT_SELECTION_SIGNAL,
  MAX_PAIN_POINTS,
  NOTE_SELECTION_SIGNAL,
  PAIN_POINT_SELECTION_SIGNAL,
  REVIEW_SIGNAL,
  type PainPointCollateralBlockInput,
} from "./blocks";
import { workflow } from "./index";

// A Granola tool step's log output is the tool result envelope: { content: JSON }.
function toolEnvelope(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

// An agentStep's output is { reply: JSON-string }.
function reply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

function gateInput(
  signalName: string,
  stepOutputs: Record<string, unknown> = {},
): PainPointCollateralBlockInput {
  return {
    runId: "run_1",
    phase: "running",
    steps: [
      {
        stepId: signalName,
        phase: "awaiting-signal",
        awaitingSignalName: signalName,
      },
    ],
    stepOutputs,
  };
}

describe("pain-point-collateral dock blocks (CL-2775)", () => {
  test("note-selection: a choice with one {noteId} option per Granola note", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(NOTE_SELECTION_SIGNAL, {
        intake: toolEnvelope({
          notes: [
            { id: "note_1", title: "Acme call", summary: "Discovery" },
            { id: "note_2", title: "Globex call" },
          ],
        }),
      }),
    );
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");
    expect(choice.signalName).toBe(NOTE_SELECTION_SIGNAL);
    expect(choice.options.map((o) => o.payload)).toEqual([
      { noteId: "note_1" },
      { noteId: "note_2" },
    ]);
    expect(choice.options[0]?.label).toBe("Acme call");
    expect(choice.options[0]?.description).toBe("Discovery");
  });

  test("note-selection: run-page link when the note list is not yet decodable", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(NOTE_SELECTION_SIGNAL),
    );
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/workflows/run_1");
  });

  test("context: a form with a single OPTIONAL context textarea", () => {
    const blocks = buildPainPointCollateralBlocks(gateInput(CONTEXT_SIGNAL));
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe(CONTEXT_SIGNAL);
    expect(form.fields.length).toBe(1);
    const field = form.fields[0];
    if (field?.kind !== "textarea")
      throw new Error("expected a textarea field");
    expect(field.name).toBe("context");
    expect(field.required ?? false).toBe(false);
  });

  test("pain-point-selection: a form multiSelect over analyze pain points, max 3", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(PAIN_POINT_SELECTION_SIGNAL, {
        analyze: reply({
          painPoints: [
            { id: "pp1", title: "Slow onboarding", detail: "Takes weeks." },
            { id: "pp2", title: "No ROI visibility", detail: "No metric." },
          ],
        }),
      }),
    );
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe(PAIN_POINT_SELECTION_SIGNAL);
    const field = form.fields[0];
    if (field?.kind !== "multiSelect") {
      throw new Error("expected a multiSelect field");
    }
    expect(field.name).toBe("selectedIds");
    expect(field.required).toBe(true);
    expect(field.max).toBe(MAX_PAIN_POINTS);
    expect(field.options.map((o) => o.value)).toEqual(["pp1", "pp2"]);
  });

  test("pain-point-selection: run-page link when analyze output is absent", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(PAIN_POINT_SELECTION_SIGNAL),
    );
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    expect(blocks.some((b) => b.kind === "link")).toBe(true);
  });

  test("format-selection: a run-page LINK (the cartesian product stays on the panel)", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(FORMAT_SELECTION_SIGNAL),
    );
    expect(blocks.some((b) => b.kind === "form")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(false);
    const link = blocks.find((b) => b.kind === "link");
    if (link?.kind !== "link") throw new Error("expected a run-page link");
    expect(link.url).toBe("/workflows/run_1");
  });

  test("review: a reviewList whose rows carry the FULL {format,title,content} payload", () => {
    const blocks = buildPainPointCollateralBlocks(
      gateInput(REVIEW_SIGNAL, {
        generate: [
          reply({ format: "email", title: "Follow-up", content: "Hi Acme…" }),
          reply({
            format: "blog",
            title: "The onboarding tax",
            content: "# Body",
          }),
        ],
      }),
    );
    const review = blocks.find((b) => b.kind === "reviewList");
    if (review?.kind !== "reviewList") {
      throw new Error("expected a reviewList block");
    }
    expect(review.signalName).toBe(REVIEW_SIGNAL);
    expect(review.approvedKey).toBe("approvedPieces");
    expect(review.rows.map((r) => r.payload)).toEqual([
      { format: "email", title: "Follow-up", content: "Hi Acme…" },
      { format: "blog", title: "The onboarding tax", content: "# Body" },
    ]);
  });

  test("renders a progress block over the run's steps", () => {
    const blocks = buildPainPointCollateralBlocks(gateInput(CONTEXT_SIGNAL));
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
  });

  test("surfaces an error block on a failed run", () => {
    const blocks = buildPainPointCollateralBlocks({
      runId: "run_4",
      phase: "failed",
      steps: [{ stepId: "analyze", phase: "failed" }],
      stepOutputs: {},
      errorMessage: "analysis failed",
    });
    const error = blocks.find((b) => b.kind === "error");
    expect(error?.kind === "error" && error.message).toBe("analysis failed");
  });

  test("surfaces the completed link when the run finishes", () => {
    const blocks = buildPainPointCollateralBlocks({
      runId: "run_5",
      phase: "completed",
      steps: [{ stepId: "persist", phase: "completed" }],
      stepOutputs: {},
      completedLink: { url: "/artifacts/art_1", title: "Open artifacts" },
    });
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");
  });
});

// ---------------------------------------------------------------------------
// The persist argMap, read from the real workflow definition — NOT hardcoded, so
// this test tracks the workflow's actual field mapping (CL-2775 fidelity guard).
// ---------------------------------------------------------------------------
function persistArgMap(): Record<string, { from: string }> {
  const persist = workflow.steps.persist;
  if (persist === undefined || persist.kind !== "map") {
    throw new Error("expected a persist map step");
  }
  const tag = persist.step.agent.tags?.[STEP_ARGMAP_TAG];
  if (tag === undefined) throw new Error("expected an argMap tag on persist");
  return JSON.parse(tag) as Record<string, { from: string }>;
}

function resolveArgMap(
  argMap: Record<string, { from: string }>,
  piece: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, selector] of Object.entries(argMap)) {
    out[key] = piece[selector.from];
  }
  return out;
}

describe("pain-point-collateral review → persist fidelity (CL-2775)", () => {
  const approvedPiece = {
    format: "email",
    title: "Follow-up to Acme",
    content: "Hi Acme, following up on the onboarding pain we discussed…",
  };

  test("each reviewList row payload resolves non-empty title/kind/content through the persist argMap", () => {
    // The reviewList block builds one row per generated piece, carrying the FULL
    // piece as its payload. On approve, the block emits those payloads verbatim
    // under `approvedPieces`; the persist map applies its argMap to each. This is
    // the integrated seam — block row payload → argMap → artifact_create args.
    const blocks = buildPainPointCollateralBlocks(
      gateInput(REVIEW_SIGNAL, { generate: [reply(approvedPiece)] }),
    );
    const review = blocks.find((b) => b.kind === "reviewList");
    if (review?.kind !== "reviewList") throw new Error("expected reviewList");

    const argMap = persistArgMap();
    for (const row of review.rows) {
      const args = resolveArgMap(
        argMap,
        row.payload as Record<string, unknown>,
      );
      expect(args.title).toBe(approvedPiece.title);
      expect(args.kind).toBe(approvedPiece.format);
      expect(args.content).toBe(approvedPiece.content);
      // The load-bearing assertion: content is non-empty. A display-fields-only
      // row payload would fail here (see the negative control below).
      expect(typeof args.content === "string" && args.content.length > 0).toBe(
        true,
      );
    }
  });

  test("negative control: a display-fields-only payload resolves EMPTY content (the bug the guard catches)", () => {
    // Proves the assertion above has teeth: had the row payload been the display
    // subset (no `content`), the persist argMap would resolve `content` to
    // undefined and the created artifact would be empty.
    const displayOnly = {
      format: approvedPiece.format,
      title: approvedPiece.title,
    };
    const args = resolveArgMap(persistArgMap(), displayOnly);
    expect(args.content).toBeUndefined();
    expect(args.title).toBe(approvedPiece.title);
    expect(args.kind).toBe(approvedPiece.format);
  });
});
