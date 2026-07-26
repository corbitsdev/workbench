import { describe, expect, test } from "bun:test";

import {
  kind,
  label,
  workflow,
  FIRECRAWL_SCRAPE_HANDLER,
  FORMAT_REPORT_DOCUMENT_HANDLER,
  BUILD_REVIEW_GATE_HANDLER,
  WRITE_ARTIFACT_HANDLER,
} from "./index";

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

function actionPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("competitor-analysis workflow structure", () => {
  test("exports the expected kind and label", () => {
    expect(kind).toBe("competitor-analysis");
    expect(label).toBe("Competitor Analysis");
    expect(workflow.id).toBe(kind);
  });

  test("declares the expected step keys in order", () => {
    expect(Object.keys(workflow.steps)).toEqual([
      "intake",
      "scrape",
      "profile",
      "discover",
      "synthesize",
      "reviewGate",
      "review",
      "document",
      "packageArtifact",
    ]);
  });

  test("intake and review are awaitSignal gates with the expected names", () => {
    const intake = workflow.steps.intake;
    if (!intake || intake.kind !== "awaitSignal")
      throw new Error("expected intake awaitSignal");
    expect(intake.name).toBe("intake");

    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.name).toBe("review");
  });

  test("scrape is a native action calling firecrawl_scrape with trigger output passed through verbatim", () => {
    const scrape = actionPrimitive("scrape");
    expect(scrape.handler).toBe(FIRECRAWL_SCRAPE_HANDLER);
    expect(FIRECRAWL_SCRAPE_HANDLER).toBe(
      "@workbench/tools-firecrawl/firecrawl:firecrawl_scrape",
    );
    // No argMap/reshape anywhere on the primitive — the input selector IS the
    // tool call arguments; intake's `url` field equals firecrawl_scrape's arg.
    expect(scrape.input).toEqual({ from: "steps.intake.output" });
    expect(scrape.effect).toEqual({ requires: [FIRECRAWL_SCRAPE_HANDLER] });
    expect(scrape.after).toEqual(["intake"]);
  });

  test("profile is a native reasoning step with a real prompt and no tools", () => {
    const profile = stepPrimitive("profile");
    expect(profile.agent.capabilities).toEqual([]);
    expect(profile.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(profile.agent.systemPrompt).toContain("discoveryQueries");
  });

  test("discover is a tool-using agent with Exa and Firecrawl capabilities", () => {
    const discover = stepPrimitive("discover");
    expect(discover.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(discover.agent.systemPrompt).toContain(
      "Corbits, Corbits.dev, Interchange, and Faremeter",
    );
    const caps = discover.agent.capabilities.join(" ");
    expect(caps).toContain("exa_search");
    expect(caps).toContain("firecrawl_scrape");
    // Must not write artifacts or invent CRM side effects.
    expect(caps).not.toContain("write_artifact");
    expect(caps).not.toContain("artifact_create");
  });

  test("synthesize is a native reasoning step with a real prompt and no tools", () => {
    const synth = stepPrimitive("synthesize");
    expect(synth.agent.capabilities).toEqual([]);
    expect(synth.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(synth.agent.systemPrompt).toContain("competitor");
  });

  test("reviewGate is a native action building the review choice from synthesize's reply", () => {
    const reviewGate = actionPrimitive("reviewGate");
    expect(reviewGate.handler).toBe(BUILD_REVIEW_GATE_HANDLER);
    expect(BUILD_REVIEW_GATE_HANDLER).toBe(
      "@workbench/workflow-competitor-analysis/core:competitor_analysis_build_review_gate",
    );
    expect(reviewGate.input).toEqual({
      project: { from: "steps.synthesize.output" },
      fields: ["reply"],
    });
    expect(reviewGate.effect).toEqual({
      requires: [BUILD_REVIEW_GATE_HANDLER],
    });
    expect(reviewGate.after).toEqual(["synthesize"]);
  });

  test("document is a native action pairing intake's url and the synthesize agent's reply into { title, body }", () => {
    const document = actionPrimitive("document");
    expect(document.handler).toBe(FORMAT_REPORT_DOCUMENT_HANDLER);
    expect(FORMAT_REPORT_DOCUMENT_HANDLER).toBe(
      "@workbench/workflow-competitor-analysis/core:competitor_analysis_format_report_document",
    );
    expect(document.input).toEqual({
      merge: [
        { from: "steps.intake.output" },
        { from: "steps.synthesize.output" },
      ],
    });
    expect(document.effect).toEqual({
      requires: [FORMAT_REPORT_DOCUMENT_HANDLER],
    });
  });

  test("packageArtifact persists via write_artifact with a merge + literal input, no argMap", () => {
    const pkg = actionPrimitive("packageArtifact");
    expect(pkg.handler).toBe(WRITE_ARTIFACT_HANDLER);
    expect(WRITE_ARTIFACT_HANDLER).toBe(
      "@workbench/tools-artifact/artifact:write_artifact",
    );
    expect(pkg.input).toEqual({
      merge: [
        { from: "steps.document.output.content" },
        { from: "steps.review.output" },
        { literal: { kind: "research", jobLabel: "Competitor analysis" } },
      ],
    });
    expect(pkg.effect).toEqual({ requires: [WRITE_ARTIFACT_HANDLER] });
  });

  test("step `after` dependencies chain serially", () => {
    expect(actionPrimitive("scrape").after).toEqual(["intake"]);
    expect(stepPrimitive("profile").after).toEqual(["scrape"]);
    expect(stepPrimitive("discover").after).toEqual(["profile"]);
    expect(stepPrimitive("synthesize").after).toEqual(["discover"]);
    expect(actionPrimitive("reviewGate").after).toEqual(["synthesize"]);
    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.after).toEqual(["reviewGate"]);
    expect(actionPrimitive("document").after).toEqual(["synthesize"]);
    expect(actionPrimitive("packageArtifact").after).toEqual([
      "document",
      "review",
    ]);
  });
});
