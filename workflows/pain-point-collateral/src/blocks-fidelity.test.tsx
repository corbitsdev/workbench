/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { type } from "arktype";
import { STEP_ARGMAP_TAG } from "@workbench/agents";
import { UIBlockView, type UIResponse } from "@workbench/blocks";
import { PainPointReviewPayloadSchema } from "@workbench/shared";
import { buildPainPointCollateralBlocks, REVIEW_SIGNAL } from "./blocks";
import { workflow } from "./index";

afterEach(() => {
  cleanup();
});

// The FULL reviewList → persist seam (CL-2775): build the review block from a
// real generate step output, render the REAL ReviewListBlock, submit it, capture
// the emitted `approvedPieces`, then apply the workflow's REAL persist argMap to
// each. Asserts every artifact_create arg (title/kind/content) resolves non-empty
// from the full piece. If a future change reduced the row payload to the display
// subset (dropping `content`), `approvedPieces` would carry no content and the
// content assertion would fail — which is exactly the regression this guards.

function reply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

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

describe("reviewList output → persist argMap fidelity (CL-2775)", () => {
  it("each approved piece from the rendered reviewList yields non-empty artifact args", () => {
    const pieces = [
      { format: "email", title: "Follow-up to Acme", content: "Hi Acme…" },
      {
        format: "blog",
        title: "The onboarding tax",
        content: "# The tax\n\nBody.",
      },
    ];
    const blocks = buildPainPointCollateralBlocks({
      runId: "run_1",
      phase: "running",
      steps: [
        {
          stepId: "review",
          phase: "awaiting-signal",
          awaitingSignalName: REVIEW_SIGNAL,
        },
      ],
      stepOutputs: { generate: pieces.map((p) => reply(p)) },
    });
    const review = blocks.find((b) => b.kind === "reviewList");
    if (review?.kind !== "reviewList") throw new Error("expected reviewList");

    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={review}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    // Every row defaults to approved; submit emits all pieces under approvedPieces.
    fireEvent.click(screen.getByRole("button", { name: /approved/ }));

    // The ACTUAL emitted payload — approvedPieces AND the decisions array the
    // block builds via decisionEntry — must pass the /resume boundary schema the
    // hub enforces, so a real dock review resume can't 400 while the suite stays
    // green (CL-2775). This validates the real emit, not a hand-fabricated shape.
    expect(
      PainPointReviewPayloadSchema(received?.payload) instanceof type.errors,
    ).toBe(false);

    const payload = received?.payload as {
      approvedPieces: unknown[];
      decisions: unknown[];
    };
    expect(payload.approvedPieces.length).toBe(2);
    // The block does emit decisions (CL-2759), even though the boundary no longer
    // hard-gates on it — confirm the real emit still carries it.
    expect(payload.decisions.length).toBe(2);

    const argMap = persistArgMap();
    payload.approvedPieces.forEach((piece, index) => {
      const args = resolveArgMap(argMap, piece as Record<string, unknown>);
      expect(args.title).toBe(pieces[index]!.title);
      expect(args.kind).toBe(pieces[index]!.format);
      expect(args.content).toBe(pieces[index]!.content);
      expect(typeof args.content === "string" && args.content.length > 0).toBe(
        true,
      );
    });
  });
});
