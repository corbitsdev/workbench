import { describe, expect, test } from "bun:test";
import { validateResumePayload } from "./resume-payload-registry";

describe("validateResumePayload", () => {
  test("passes through an unregistered workflow kind", () => {
    expect(
      validateResumePayload("some-other-workflow", "sync-approval", {
        anything: 1,
      }),
    ).toEqual({ ok: true });
  });

  test("passes through an unregistered signal on a registered kind", () => {
    // The review gate carries a multi-field draft-approval FORM the dock can't
    // collect — it is deferred to the run page (CL-2731), so its payload is not
    // boundary-validated here and passes through.
    expect(
      validateResumePayload("attio-task-agent", "review", {
        approvedPieces: [{ type: "cold-email", title: "x", content: "y" }],
      }),
    ).toEqual({ ok: true });
  });

  test("accepts a member-selection payload with an assignee", () => {
    expect(
      validateResumePayload("attio-task-agent", "member-selection", {
        assignee: "sawyer@abklabs.com",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a member-selection payload with no assignee", () => {
    // The dock choice block and the panel both POST `{ assignee }`; a hollow pick
    // must not reach the listTasks tool step (it would query with no assignee).
    const result = validateResumePayload(
      "attio-task-agent",
      "member-selection",
      {},
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a member-selection payload with an empty-string assignee", () => {
    // An empty string is a hollow pick — it passes a bare `string` type but must
    // not reach listTasks (which would query with no assignee). The `string > 0`
    // constraint rejects it at the boundary.
    const result = validateResumePayload(
      "attio-task-agent",
      "member-selection",
      { assignee: "" },
    );
    expect(result.ok).toBe(false);
  });

  test("accepts a task-selection payload with a taskId", () => {
    expect(
      validateResumePayload("attio-task-agent", "task-selection", {
        taskId: "task_1",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a task-selection payload with no taskId", () => {
    const result = validateResumePayload(
      "attio-task-agent",
      "task-selection",
      {},
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a task-selection payload with an empty-string taskId", () => {
    const result = validateResumePayload("attio-task-agent", "task-selection", {
      taskId: "",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a clarification payload with answers or an empty continue", () => {
    // `answers` is optional — an empty continue is a valid best-effort proceed.
    expect(
      validateResumePayload("attio-task-agent", "clarification", {}),
    ).toEqual({ ok: true });
    expect(
      validateResumePayload("attio-task-agent", "clarification", {
        answers: "The prospect is a Series B fintech.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a clarification payload with a non-string answers", () => {
    const result = validateResumePayload("attio-task-agent", "clarification", {
      answers: 42,
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a bare attio sync-approval skip payload", () => {
    expect(
      validateResumePayload("attio-task-agent", "sync-approval", {
        confirm: false,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an attio sync-approval payload with a non-boolean confirm", () => {
    const result = validateResumePayload("attio-task-agent", "sync-approval", {
      confirm: "yes",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a free-text-only ab-compare-hitl decision (no ranking)", () => {
    // A blind winner-pick cannot be free text — it must carry a ranking.
    const result = validateResumePayload("ab-compare-hitl", "ab-decision", {
      instruction: "Variant 1 reads better to me.",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an ab-compare-hitl decision with an empty ranking", () => {
    const result = validateResumePayload("ab-compare-hitl", "ab-decision", {
      ranking: [],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a structured ab-compare-hitl decision with a ranked winner", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-decision", {
        ranking: [{ rank: 1, label: "Variant 2", rationale: "Punchier." }],
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an empty ab-compare-hitl config payload", () => {
    // The generic "Continue" affordance would POST `{ instruction: "" }`; the
    // config gate needs fully-specified variants + input.
    const result = validateResumePayload("ab-compare-hitl", "ab-config", {
      instruction: "",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts an ab-compare-hitl config payload with variants and input", () => {
    expect(
      validateResumePayload("ab-compare-hitl", "ab-config", {
        variants: [
          {
            label: "Variant 1",
            providerName: "openai",
            model: "gpt-4o",
            input: "Write a tagline.",
          },
        ],
        input: "Write a tagline.",
      }),
    ).toEqual({ ok: true });
  });

  test("accepts a gamma preview approval on any round's gate", () => {
    for (const signal of ["preview-1", "preview-2", "preview-3"]) {
      expect(
        validateResumePayload("gamma-presentation-creator", signal, {
          approved: true,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("accepts a gamma preview refine with feedback", () => {
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-1", {
        approved: false,
        feedback: "Tighten the opening slide.",
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a gamma refine with no feedback (guidance-less re-roll)", () => {
    // A refine (`approved: false`) drives the next `generate-N` step; without a
    // note it would blind re-roll, so the boundary rejects it (CL-2730).
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-1", {
        approved: false,
      }).ok,
    ).toBe(false);
  });

  test("rejects a gamma refine with an empty-string feedback", () => {
    expect(
      validateResumePayload("gamma-presentation-creator", "preview-2", {
        approved: false,
        feedback: "",
      }).ok,
    ).toBe(false);
  });

  test("rejects a hollow gamma preview payload with no decision", () => {
    // The generic free-text path would POST `{ instruction: "..." }`; the check
    // gate branches on `approved`, so a payload without it is not a decision.
    const result = validateResumePayload(
      "gamma-presentation-creator",
      "preview-1",
      { instruction: "looks fine" },
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a gamma preview payload with a non-boolean approved", () => {
    const result = validateResumePayload(
      "gamma-presentation-creator",
      "preview-2",
      { approved: "yes" },
    );
    expect(result.ok).toBe(false);
  });
});
