import { describe, expect, it } from "bun:test";
import { morningBriefMailRefs } from "./heartbeat-brief-mail-refs";

describe("morningBriefMailRefs", () => {
  it("returns artifact and workflow_run refs", () => {
    expect(morningBriefMailRefs(" art_1 ", " run_abc ")).toEqual([
      { kind: "artifact", ref: "art_1", label: "Open brief" },
      {
        kind: "workflow_run",
        ref: "run_abc",
        label: "Open Company Heartbeat",
      },
    ]);
  });

  it("uses a custom workflow label", () => {
    const refs = morningBriefMailRefs("a1", "r1", "My Workflow");
    expect(refs[1]).toEqual({
      kind: "workflow_run",
      ref: "r1",
      label: "Open My Workflow",
    });
  });

  it("rejects empty artifactId or runId", () => {
    expect(() => morningBriefMailRefs("", "r1")).toThrow(/artifactId/);
    expect(() => morningBriefMailRefs("a1", "")).toThrow(/runId/);
  });
});