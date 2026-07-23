import { describe, expect, test } from "bun:test";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "@workbench/agents";

import { kind, label, workflow } from "./index";

function stepPrimitive(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected step primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
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

  test("scrape is a deterministic firecrawl_scrape mapping companyUrl → url", () => {
    const scrape = stepPrimitive("scrape");
    expect(scrape.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(scrape.agent.tags?.[STEP_TOOL_TAG]).toContain("firecrawl_scrape");
    expect(scrape.agent.inference.sources).toEqual([]);
    expect(scrape.input).toEqual({ from: "steps.intake.output" });
    const argMap = scrape.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined) throw new Error("expected argMap on scrape");
    expect(JSON.parse(argMap)).toEqual({
      url: { from: "companyUrl" },
    });
  });

  test("profile is a native reasoning step (agentStep) with a real prompt and no tools", () => {
    const profile = stepPrimitive("profile");
    expect(profile.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(profile.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(profile.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(profile.agent.systemPrompt).toContain("discoveryQueries");
  });

  test("discover is a tool-using agent with Exa and Firecrawl capabilities", () => {
    const discover = stepPrimitive("discover");
    // Tool-using ReAct step — not a deterministicToolStep / agentStep.
    expect(discover.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
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

  test("synthesize is a native reasoning step (agentStep) with a real prompt and no tools", () => {
    const synth = stepPrimitive("synthesize");
    expect(synth.agent.tags?.[STEP_KIND_TAG]).toBeUndefined();
    expect(synth.agent.tags?.[STEP_TOOL_TAG]).toBeUndefined();
    expect(synth.agent.systemPrompt.length).toBeGreaterThan(0);
    expect(synth.agent.systemPrompt).toContain("competitor");
  });

  test("document pairs companyUrl and the synthesize agent's reply into { title, body }", () => {
    const document = stepPrimitive("document");
    expect(document.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(document.agent.tags?.[STEP_TOOL_TAG]).toContain(
      "competitor_analysis_format_report_document",
    );
    expect(document.agent.tags?.[STEP_ARGMAP_TAG]).toBeUndefined();
  });

  test("packageArtifact persists via write_artifact with the research argMap", () => {
    const pkg = stepPrimitive("packageArtifact");
    expect(pkg.agent.tags?.[STEP_KIND_TAG]).toBe(DETERMINISTIC_TOOL_KIND);
    expect(pkg.agent.tags?.[STEP_TOOL_TAG]).toContain("write_artifact");
    const argMap = pkg.agent.tags?.[STEP_ARGMAP_TAG];
    if (argMap === undefined)
      throw new Error("expected argMap on packageArtifact");
    expect(JSON.parse(argMap)).toEqual({
      title: { from: "title" },
      body: { from: "body" },
      kind: { literal: "research" },
      jobLabel: { literal: "Competitor analysis" },
    });
  });

  test("step `after` dependencies chain serially", () => {
    expect(stepPrimitive("scrape").after).toEqual(["intake"]);
    expect(stepPrimitive("profile").after).toEqual(["scrape"]);
    expect(stepPrimitive("discover").after).toEqual(["profile"]);
    expect(stepPrimitive("synthesize").after).toEqual(["discover"]);
    const review = workflow.steps.review;
    if (!review || review.kind !== "awaitSignal")
      throw new Error("expected review awaitSignal");
    expect(review.after).toEqual(["synthesize"]);
    expect(stepPrimitive("document").after).toEqual(["synthesize"]);
    expect(stepPrimitive("packageArtifact").after).toEqual([
      "document",
      "review",
    ]);
  });
});
