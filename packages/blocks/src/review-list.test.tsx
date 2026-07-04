/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type } from "arktype";
import React from "react";

import { UIBlockView } from "./UIBlockView";
import {
  ReviewListDecisionSchema,
  isUIBlock,
  type UIBlock,
  type UIResponse,
} from "./ui-block";

afterEach(() => {
  cleanup();
});

// A workflow-OWNED resume schema (CL-2759) standing in for the attio review
// gate's boundary validator: it expects the approved records under
// `approvedPieces` plus a per-row `decisions` array. The shared package never
// hardcodes a per-workflow payload shape — this proves the emitted payload
// round-trips through a real boundary check.
const AttioReviewSchema = type({
  approvedPieces: type({ recordId: "string", name: "string" }).array(),
  decisions: ReviewListDecisionSchema.array().atLeastLength(1),
});

function makeBlock(
  overrides: Partial<Extract<UIBlock, { kind: "reviewList" }>> = {},
) {
  const block: UIBlock = {
    kind: "reviewList",
    title: "Review CRM records",
    prompt: "Approve the records to sync.",
    signalName: "attio-review",
    displayFields: [
      { key: "name", label: "Name" },
      { key: "summary", label: "Summary", kind: "markdown" },
      { key: "stage", label: "Stage", kind: "badge" },
    ],
    rows: [
      {
        id: "r1",
        fields: { name: "Acme", summary: "**Hot** lead", stage: "Prospect" },
        payload: {
          recordId: "rec_1",
          name: "Acme",
          full: { notes: "call notes" },
        },
      },
      {
        id: "r2",
        fields: { name: "Globex", summary: "cold", stage: "Lost" },
        payload: { recordId: "rec_2", name: "Globex" },
      },
      {
        id: "r3",
        fields: { name: "Initech", summary: "warm", stage: "Prospect" },
        payload: { recordId: "rec_3", name: "Initech" },
      },
    ],
    ...overrides,
  };
  return block;
}

describe("reviewList block", () => {
  it("renders one row per record with its display fields", () => {
    render(<UIBlockView block={makeBlock()} />);
    expect(screen.getAllByTestId("review-row").length).toBe(3);
    // getByText throws if absent, so the call IS the assertion.
    screen.getByText("Acme");
    screen.getByText("Globex");
    screen.getByText("Initech");
    // Two rows carry a "Prospect" badge — both render.
    expect(screen.getAllByText("Prospect").length).toBe(2);
  });

  it("renders a markdown display field as rendered markdown, not raw source", () => {
    render(<UIBlockView block={makeBlock()} />);
    // The `**Hot**` markdown must render to a <strong>, not literal asterisks.
    const strong = screen.getByText("Hot");
    expect(strong.tagName).toBe("STRONG");
  });

  it("defaults every row to approved and emits all payloads under approvedPieces", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={makeBlock()}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit 3 approved/ }));
    expect(received?.blockKind).toBe("reviewList");
    expect(received?.signalName).toBe("attio-review");
    const payload = received?.payload as {
      approvedPieces: unknown[];
      decisions: Record<string, unknown>[];
    };
    expect(payload.approvedPieces).toEqual([
      { recordId: "rec_1", name: "Acme", full: { notes: "call notes" } },
      { recordId: "rec_2", name: "Globex" },
      { recordId: "rec_3", name: "Initech" },
    ]);
    // decisions covers EVERY row, each with the full payload spread + approved.
    expect(payload.decisions.length).toBe(3);
    expect(payload.decisions.every((d) => d.approved === true)).toBe(true);
    expect(payload.decisions[0]).toEqual({
      recordId: "rec_1",
      name: "Acme",
      full: { notes: "call notes" },
      approved: true,
    });
  });

  it("rejecting a row removes its payload from approvedPieces but keeps it in decisions", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={makeBlock()}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    // Reject the second row (Globex) via its Reject toggle.
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });
    fireEvent.click(rejectButtons[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Submit 2 approved/ }));

    const payload = received?.payload as {
      approvedPieces: { recordId: string }[];
      decisions: { recordId: string; approved: boolean }[];
    };
    expect(payload.approvedPieces.map((p) => p.recordId)).toEqual([
      "rec_1",
      "rec_3",
    ]);
    // decisions still covers all three, with the rejected row marked false.
    expect(
      payload.decisions.map((d) => ({ id: d.recordId, approved: d.approved })),
    ).toEqual([
      { id: "rec_1", approved: true },
      { id: "rec_2", approved: false },
      { id: "rec_3", approved: true },
    ]);
  });

  it("honors per-row defaultDecision: 'rejected'", () => {
    let received: UIResponse | undefined;
    const block = makeBlock();
    block.rows[1]!.defaultDecision = "rejected";
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    // Row 2 starts rejected, so only 2 are approved by default.
    fireEvent.click(screen.getByRole("button", { name: /Submit 2 approved/ }));
    const payload = received?.payload as {
      approvedPieces: { recordId: string }[];
    };
    expect(payload.approvedPieces.map((p) => p.recordId)).toEqual([
      "rec_1",
      "rec_3",
    ]);
  });

  it("holds submit while the approved count is outside [min, max]", () => {
    // min 1, max 2 — all three approved by default is over max.
    render(<UIBlockView block={makeBlock({ min: 1, max: 2 })} />);
    const submit = screen.getByRole("button", { name: /approved/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // 3 > max 2
    // Reject one → 2 approved, now in range.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    // Reject another → 1 still in range.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    // Reject the last → 0 < min 1, held again.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[2]!);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("emits under a custom approvedKey (reddit-selection uses 'selected')", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={makeBlock({ approvedKey: "selected" })}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Submit 2 approved/ }));
    const payload = received?.payload as Record<string, unknown>;
    expect(payload.selected).toEqual([
      { recordId: "rec_2", name: "Globex" },
      { recordId: "rec_3", name: "Initech" },
    ]);
    expect(payload).not.toHaveProperty("approvedPieces");
  });

  it("emits a payload the workflow-owned boundary schema accepts", () => {
    let received: UIResponse | undefined;
    render(
      <UIBlockView
        block={makeBlock()}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit 3 approved/ }));
    const out = AttioReviewSchema(received?.payload);
    expect(out instanceof type.errors).toBe(false);
    // A payload missing decisions is rejected by the same boundary schema.
    expect(
      AttioReviewSchema({ approvedPieces: [] }) instanceof type.errors,
    ).toBe(true);
  });

  it("keeps the rows populated and surfaces an inline error when the resume fails", async () => {
    const onRespond = () => Promise.reject(new Error("stale gate"));
    render(<UIBlockView block={makeBlock()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /Submit 3 approved/ }));
    await screen.findByText("stale gate");
    // Not collapsed to the submitted note — the rows are still there to retry.
    expect(screen.queryByText(/Approved 3 of 3\./)).toBeNull();
    expect(screen.getAllByTestId("review-row").length).toBe(3);
  });

  it("shows a live 'Submitting…' state while the resume is in flight, then collapses", async () => {
    let resolve: (() => void) | undefined;
    const onRespond = () =>
      new Promise<void>((res) => {
        resolve = res;
      });
    render(<UIBlockView block={makeBlock()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /Submit 3 approved/ }));
    await screen.findByText("Submitting…");
    resolve?.();
    await screen.findByText("Approved 3 of 3.");
  });
});

describe("reviewList block — hardening edge cases (CL-2759)", () => {
  it("renders an empty state and still submits an empty set past the gate when rows are empty", () => {
    let received: UIResponse | undefined;
    const block = makeBlock({ rows: [] });
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    // Explicit empty state instead of a bare list + "Submit 0 approved".
    screen.getByText("No records to review.");
    const submit = screen.getByRole("button", { name: /Submit 0 approved/ });
    // With the default min 0, the gate is passable so the workflow can proceed.
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(received?.payload).toEqual({
      approvedPieces: [],
      decisions: [],
    });
  });

  it("holds submit on empty rows when min > 0", () => {
    render(<UIBlockView block={makeBlock({ rows: [], min: 1 })} />);
    screen.getByText("No records to review.");
    expect(
      (
        screen.getByRole("button", {
          name: /Submit 0 approved/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not wedge submit permanently disabled when max < min (clamped)", () => {
    // A caller passing max 1 < min 2 would leave inRange UNSATISFIABLE without
    // the clamp: no count can be both >= 2 and <= 1. The clamp raises the
    // effective ceiling to `min` (2), so approving exactly 2 is a reachable,
    // submittable state.
    render(<UIBlockView block={makeBlock({ min: 2, max: 1 })} />);
    const submit = screen.getByRole("button", { name: /approved/ });
    // 3 approved by default is over the clamped ceiling of 2 → held.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // Reject one → 2 approved, now within [2, 2] — submit is reachable.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a range hint when submit is held below min", () => {
    render(<UIBlockView block={makeBlock({ min: 1, max: 2 })} />);
    // 3 approved by default, over max 2 → held, with an at-most hint.
    screen.getByText("Approve at most 2 to continue.");
    // Reject all three → below min 1, hint flips to at-least.
    for (const reject of screen.getAllByRole("button", { name: "Reject" })) {
      fireEvent.click(reject);
    }
    screen.getByText("Approve at least 1 to continue.");
  });

  it("nests a non-object payload under a `payload` key with the verdict", () => {
    let received: UIResponse | undefined;
    const block = makeBlock({
      rows: [
        { id: "r1", fields: { name: "A" }, payload: "raw-string" },
        { id: "r2", fields: { name: "B" }, payload: 42 },
      ],
    });
    render(
      <UIBlockView
        block={block}
        onRespond={(response) => {
          received = response;
        }}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 approved/ }));
    const payload = received?.payload as {
      approvedPieces: unknown[];
      decisions: unknown[];
    };
    expect(payload.approvedPieces).toEqual(["raw-string"]);
    expect(payload.decisions).toEqual([
      { payload: "raw-string", approved: true },
      { payload: 42, approved: false },
    ]);
  });
});

describe("isUIBlock guard — reviewList", () => {
  it("accepts a well-formed reviewList block", () => {
    expect(
      isUIBlock({
        kind: "reviewList",
        displayFields: [{ key: "name", label: "Name" }],
        rows: [{ id: "r1", fields: { name: "Acme" }, payload: {} }],
      }),
    ).toBe(true);
  });

  it("rejects a reviewList with no display fields", () => {
    expect(
      isUIBlock({
        kind: "reviewList",
        displayFields: [],
        rows: [{ id: "r1", fields: {}, payload: {} }],
      }),
    ).toBe(false);
  });

  it("rejects a reviewList row missing its payload key", () => {
    expect(
      isUIBlock({
        kind: "reviewList",
        displayFields: [{ key: "name", label: "Name" }],
        rows: [{ id: "r1", fields: { name: "Acme" } }],
      }),
    ).toBe(false);
  });
});
