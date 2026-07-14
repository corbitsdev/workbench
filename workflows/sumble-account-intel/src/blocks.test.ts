import { describe, expect, test } from "bun:test";
import {
  buildSumbleAccountIntelBlocks,
  INTAKE_SIGNAL,
  REVIEW_SIGNAL,
  type SumbleAccountIntelBlockInput,
} from "./blocks";

function reply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

function gateInput(
  signalName: string,
  stepOutputs: Record<string, unknown> = {},
): SumbleAccountIntelBlockInput {
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

const BRIEF = {
  title: "Acme — account brief",
  content: "## Account summary\nAcme builds things.",
  contactsCsv: "name,title,email,x_handle\nAda,,,",
  slackDraft: "Acme is worth a look.",
};

describe("sumble-account-intel dock blocks", () => {
  test("intake: a form with a single required organizationDomain text field", () => {
    const blocks = buildSumbleAccountIntelBlocks(gateInput(INTAKE_SIGNAL));
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe(INTAKE_SIGNAL);
    expect(form.fields).toHaveLength(1);
    const field = form.fields[0];
    if (field?.kind !== "text") throw new Error("expected a text field");
    expect(field.name).toBe("organizationDomain");
    expect(field.required).toBe(true);
  });

  test("review: a choice with Approve/Reject options carrying the {approved} payload", () => {
    const blocks = buildSumbleAccountIntelBlocks(
      gateInput(REVIEW_SIGNAL, { synthesize: reply(BRIEF) }),
    );
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");
    expect(choice.signalName).toBe(REVIEW_SIGNAL);
    expect(choice.options.map((o) => o.payload)).toEqual([
      { approved: true },
      { approved: false },
    ]);
  });

  test("review: shows the decoded brief as a markdown preview above the choice", () => {
    const blocks = buildSumbleAccountIntelBlocks(
      gateInput(REVIEW_SIGNAL, { synthesize: reply(BRIEF) }),
    );
    const md = blocks.find((b) => b.kind === "markdown");
    if (md?.kind !== "markdown") throw new Error("expected a markdown block");
    expect(md.source).toBe(BRIEF.content);
    expect(md.title).toBe(BRIEF.title);
  });

  test("review: still renders the choice when the brief is not yet decodable", () => {
    const blocks = buildSumbleAccountIntelBlocks(gateInput(REVIEW_SIGNAL));
    expect(blocks.some((b) => b.kind === "markdown")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(true);
  });

  test("renders a progress block over the run's steps", () => {
    const blocks = buildSumbleAccountIntelBlocks(gateInput(INTAKE_SIGNAL));
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
  });

  test("surfaces an error block on a failed run", () => {
    const blocks = buildSumbleAccountIntelBlocks({
      runId: "run_2",
      phase: "failed",
      steps: [{ stepId: "resolve", phase: "failed" }],
      stepOutputs: {},
      errorMessage: "resolve failed",
    });
    const error = blocks.find((b) => b.kind === "error");
    expect(error?.kind === "error" && error.message).toBe("resolve failed");
  });

  test("surfaces the completed link when the run finishes", () => {
    const blocks = buildSumbleAccountIntelBlocks({
      runId: "run_3",
      phase: "completed",
      steps: [{ stepId: "packageArtifact", phase: "completed" }],
      stepOutputs: {},
      completedLink: { url: "/artifacts/art_1", title: "Open the brief" },
    });
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/art_1");
  });
});
