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
    // The action plan is agent-decided (CL-2664) — there is no kind-selection
    // signal to validate; the human review carries approved pieces, unvalidated.
    expect(
      validateResumePayload("attio-task-agent", "task-selection", {
        taskId: "t1",
      }),
    ).toEqual({ ok: true });
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
});
