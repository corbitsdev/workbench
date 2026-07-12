import { describe, expect, test } from "bun:test";
import { buildMorningBriefSystemPrompt } from "./prompts";
import { WIRED_BRIEF_SOURCES } from "@workbench/shared";

describe("buildMorningBriefSystemPrompt", () => {
  test("defaults to WIRED_BRIEF_SOURCES and names every source", () => {
    const prompt = buildMorningBriefSystemPrompt();
    for (const source of WIRED_BRIEF_SOURCES) {
      expect(prompt).toContain(source.label);
    }
  });

  test("is generic prose, not hard-coded Granola-only wording", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).not.toContain("recent Granola call notes");
  });

  test("names a synthetic multi-source list generically", () => {
    const prompt = buildMorningBriefSystemPrompt([
      { key: "granola", label: "Granola" },
      { key: "linear", label: "Linear" },
    ]);
    expect(prompt).toContain("Granola");
    expect(prompt).toContain("Linear");
  });

  test("describes an empty source list without naming any source", () => {
    const prompt = buildMorningBriefSystemPrompt([]);
    expect(prompt).toContain("your connected sources");
  });

  test("still emits the fixed output section headers", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).toContain("## What happened");
    expect(prompt).toContain("## What needs attention today");
    expect(prompt).toContain("## Suggested next actions");
  });

  test("preserves the skipped/unavailable degrade-honestly rule", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).toContain('"skipped": true');
    expect(prompt).toContain('"isError": true');
    expect(prompt).toContain("never as an error, failure, or missing data");
  });
});
