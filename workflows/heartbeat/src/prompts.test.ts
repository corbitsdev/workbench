import { describe, expect, test } from "bun:test";
import { buildMorningBriefSystemPrompt } from "./prompts";
import { WIRED_BRIEF_SOURCES } from "./heartbeat-shared";

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

  test("instructs tailoring the brief to the specific active user (CL-3501)", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).toContain("userDisplayName");
    expect(prompt).toContain("Write the brief FOR this specific person");
  });

  test("instructs rendering source items with a url as markdown links (CL-3504)", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).toContain("must be rendered as a markdown link");
    expect(prompt).toContain("Never fabricate a url");
  });

  test("documents the recency slice keys the intake tools emit (CL-4087)", () => {
    const prompt = buildMorningBriefSystemPrompt();
    for (const key of [
      "newCompanies",
      "recentlyTouchedCompanies",
      "newTasks",
      "completedTasks",
      "longOpenTasks",
      "newIssues",
      "updatedIssues",
      "completedIssues",
      "updatedOnly",
    ]) {
      expect(prompt).toContain(key);
    }
  });

  test("instructs leading with new activity and separating carry-over items (CL-4087)", () => {
    const prompt = buildMorningBriefSystemPrompt();
    expect(prompt).toContain("Still open");
    expect(prompt).toContain(
      'never present them as new activity or as "what happened"',
    );
  });
});
