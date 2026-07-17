import { describe, expect, it } from "bun:test";
import {
  MAX_PINNED_MYRA_SKILLS,
  filterPinnedEntriesForSurface,
  isPinnedSkillTriageRelevant,
  oneLineSkillDescription,
  renderPinnedSkillsSection,
} from "./pinned-skills";

describe("pinned skills prompt index", () => {
  it("renders names and one-line descriptions, never bodies", () => {
    const section = renderPinnedSkillsSection(
      [
        { name: "Weekly recap", description: "Summarize the week." },
        { name: "Inbox triage", description: "How to label mail." },
      ],
      "xml",
    );
    expect(section).not.toBeNull();
    expect(section).toContain("Weekly recap");
    expect(section).toContain("Summarize the week.");
    expect(section).toContain("Pinned-skills");
    expect(section).not.toContain("# Step 1");
    expect(section).not.toContain("SKILL.md");
  });

  it("returns null when there are no entries", () => {
    expect(renderPinnedSkillsSection([], "xml")).toBeNull();
  });

  it("enforces the documented max bound constant", () => {
    expect(MAX_PINNED_MYRA_SKILLS).toBe(10);
  });

  it("skips triage when no entry is triage-relevant", () => {
    const entries = [{ name: "Chat only", description: "myra-surface: chat-only" }];
    const flags = [isPinnedSkillTriageRelevant(entries[0]!.description)];
    expect(filterPinnedEntriesForSurface("triage", entries, flags)).toEqual([]);
    expect(filterPinnedEntriesForSurface("chat", entries, flags)).toEqual(entries);
  });

  it("uses the first line for multi-line descriptions", () => {
    expect(oneLineSkillDescription("Line one\nLine two")).toBe("Line one");
  });
});