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
});
