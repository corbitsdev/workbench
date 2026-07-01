import { describe, expect, test } from "bun:test";
import { attioTaskArtifactKinds } from "@workbench/shared";
import { validateResumePayload } from "./resume-payload-registry";

function completeGenerateMap(): Record<string, boolean> {
  const generate: Record<string, boolean> = {};
  for (const kind of attioTaskArtifactKinds) generate[kind] = false;
  return generate;
}

describe("validateResumePayload", () => {
  test("passes through an unregistered workflow kind", () => {
    expect(
      validateResumePayload("some-other-workflow", "kind-selection", {
        anything: 1,
      }),
    ).toEqual({ ok: true });
  });

  test("passes through an unregistered signal on a registered kind", () => {
    expect(
      validateResumePayload("attio-task-agent", "task-selection", {
        taskId: "t1",
      }),
    ).toEqual({ ok: true });
  });

  test("accepts a complete attio kind-selection payload", () => {
    expect(
      validateResumePayload("attio-task-agent", "kind-selection", {
        generate: completeGenerateMap(),
      }),
    ).toEqual({ ok: true });
  });

  test("rejects an attio kind-selection payload missing a kind", () => {
    const generate = completeGenerateMap();
    delete generate.blog;
    const result = validateResumePayload("attio-task-agent", "kind-selection", {
      generate,
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
});
