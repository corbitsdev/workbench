import { describe, expect, test } from "bun:test";
import {
  buildCompetitorAnalysisBlocks,
  INTAKE_SIGNAL,
  REVIEW_SIGNAL,
  type CompetitorAnalysisBlockInput,
} from "./blocks";

function reply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

function gateInput(
  signalName: string,
  stepOutputs: Record<string, unknown> = {},
): CompetitorAnalysisBlockInput {
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

const REPORT = {
  title: "Acme — competitor analysis",
  content: "## Subject\nAcme sells CRM.",
  competitors: [
    {
      name: "HubSpot",
      website: "https://hubspot.com",
      segment: "direct",
      whyCompetes: "Same buyer.",
      sources: ["https://hubspot.com"],
    },
  ],
};

describe("competitor-analysis dock blocks", () => {
  test("intake: form with required companyUrl and optional name/focus", () => {
    const blocks = buildCompetitorAnalysisBlocks(gateInput(INTAKE_SIGNAL));
    const form = blocks.find((b) => b.kind === "form");
    if (form?.kind !== "form") throw new Error("expected a form block");
    expect(form.signalName).toBe(INTAKE_SIGNAL);
    expect(form.fields.map((f) => f.name)).toEqual([
      "companyUrl",
      "companyName",
      "focusNotes",
    ]);
    const url = form.fields[0];
    if (url?.kind !== "text") throw new Error("expected companyUrl text field");
    expect(url.required).toBe(true);
  });

  test("review: choice with Approve/Reject carrying {approved}", () => {
    const blocks = buildCompetitorAnalysisBlocks(
      gateInput(REVIEW_SIGNAL, { synthesize: reply(REPORT) }),
    );
    const choice = blocks.find((b) => b.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("expected a choice block");
    expect(choice.signalName).toBe(REVIEW_SIGNAL);
    expect(choice.options.map((o) => o.payload)).toEqual([
      { approved: true },
      { approved: false },
    ]);
  });

  test("review: shows decoded report markdown above the choice", () => {
    const blocks = buildCompetitorAnalysisBlocks(
      gateInput(REVIEW_SIGNAL, { synthesize: reply(REPORT) }),
    );
    const md = blocks.find((b) => b.kind === "markdown");
    if (md?.kind !== "markdown") throw new Error("expected a markdown block");
    expect(md.source).toBe(REPORT.content);
    expect(md.title).toBe(REPORT.title);
  });

  test("review: still renders the choice when the report is not decodable", () => {
    const blocks = buildCompetitorAnalysisBlocks(gateInput(REVIEW_SIGNAL));
    expect(blocks.some((b) => b.kind === "markdown")).toBe(false);
    expect(blocks.some((b) => b.kind === "choice")).toBe(true);
  });

  test("renders a progress block over the run's steps", () => {
    const blocks = buildCompetitorAnalysisBlocks(gateInput(INTAKE_SIGNAL));
    expect(blocks.some((b) => b.kind === "progress")).toBe(true);
  });

  test("surfaces an error block on a failed run", () => {
    const blocks = buildCompetitorAnalysisBlocks({
      runId: "run_2",
      phase: "failed",
      steps: [{ stepId: "scrape", phase: "failed" }],
      stepOutputs: {},
      errorMessage: "scrape failed",
    });
    const error = blocks.find((b) => b.kind === "error");
    expect(error?.kind === "error" && error.message).toBe("scrape failed");
  });

  test("surfaces the completed link when the run finishes", () => {
    const blocks = buildCompetitorAnalysisBlocks({
      runId: "run_3",
      phase: "completed",
      steps: [{ stepId: "packageArtifact", phase: "completed" }],
      stepOutputs: {},
      completedLink: {
        url: "/artifacts/a1",
        title: "Open report",
        description: "Saved research artifact",
      },
    });
    const link = blocks.find((b) => b.kind === "link");
    expect(link?.kind === "link" && link.url).toBe("/artifacts/a1");
  });
});
