import { describe, expect, it } from "bun:test";
import {
  morningBriefMailRefs,
  morningBriefNotifyMail,
} from "./heartbeat-brief-mail-refs";

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

describe("morningBriefNotifyMail", () => {
  it("composes the mail_send argument shape from the brief document + refs", () => {
    expect(
      morningBriefNotifyMail({
        userAddress: "usr_abc123@workbench.local",
        title: "Jordan Lee's Morning Brief - 04/07/26",
        body: "# Morning brief\n\nAll clear today.",
        artifactId: "art_1",
        runId: "run-heartbeat-1",
        workflowLabel: "Morning brief",
      }),
    ).toEqual({
      to: "usr_abc123@workbench.local",
      subject: "Jordan Lee's Morning Brief - 04/07/26",
      content: "# Morning brief\n\nAll clear today.",
      refs: [
        { kind: "artifact", ref: "art_1", label: "Open brief" },
        {
          kind: "workflow_run",
          ref: "run-heartbeat-1",
          label: "Open Morning brief",
        },
      ],
    });
  });

  it("rejects an empty userAddress or title", () => {
    expect(() =>
      morningBriefNotifyMail({
        userAddress: "",
        title: "t",
        body: "b",
        artifactId: "a1",
        runId: "r1",
      }),
    ).toThrow(/userAddress/);
    expect(() =>
      morningBriefNotifyMail({
        userAddress: "usr_1@workbench.local",
        title: "",
        body: "b",
        artifactId: "a1",
        runId: "r1",
      }),
    ).toThrow(/title/);
  });
});
