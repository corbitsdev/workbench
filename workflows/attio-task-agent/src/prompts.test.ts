import { describe, expect, test } from "bun:test";
import { attioTaskArtifactKinds } from "@workbench/shared";
import {
  ARTIFACT_KIND_GUIDANCE,
  buildAnalyzeSystemPrompt,
  buildExecutorSystemPrompt,
  buildReviewSystemPrompt,
} from "./prompts";

describe("planner prompt", () => {
  test("asks for an action plan (draftActions), not a hand-pick", () => {
    const p = buildAnalyzeSystemPrompt();
    expect(p).toContain("draftActions");
    expect(p).toContain("PLANNER");
    // The planner proposes destructive write-back separately, human-approved.
    expect(p).toContain("proposedTaskUpdate");
  });
});

describe("executor prompt", () => {
  test("every artifact kind has a guidance block, all carried by the executor", () => {
    const p = buildExecutorSystemPrompt();
    for (const kind of attioTaskArtifactKinds) {
      expect(ARTIFACT_KIND_GUIDANCE[kind]?.length).toBeGreaterThan(0);
      expect(p).toContain(kind);
    }
  });

  test("performs every action and returns an outputs array", () => {
    const p = buildExecutorSystemPrompt();
    expect(p).toContain("draftActions");
    expect(p).toContain('"outputs"');
    // Both anonymized and outreach guidance are present — the executor focuses
    // on the single action's type from its input.
    expect(p).toContain("ANONYMIZED");
    expect(p).toContain("cold outreach");
  });
});

describe("reviewer prompt", () => {
  test("validates each output against its brief with a verdict", () => {
    const p = buildReviewSystemPrompt();
    expect(p).toContain("verdict");
    expect(p).toContain("brief");
    expect(p).toContain("Do not rewrite");
  });
});
