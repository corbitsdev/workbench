import { describe, expect, test } from "bun:test";

import { isValidSlug, slugify, SLUG_MAX_LENGTH } from "./slug";

describe("slugify", () => {
  test("kebab-cases a display name", () => {
    expect(slugify("Triage Bot")).toBe("triage-bot");
    expect(slugify("Release   Notes")).toBe("release-notes");
  });

  test("folds accents to ASCII", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
  });

  test("collapses punctuation and trims stray hyphens", () => {
    expect(slugify("  --Weekly (report)! -- ")).toBe("weekly-report");
    expect(slugify("PR/issue triage")).toBe("pr-issue-triage");
  });

  test("keeps digits", () => {
    expect(slugify("Sprint 42 recap")).toBe("sprint-42-recap");
  });

  test("caps length without leaving a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(SLUG_MAX_LENGTH)} tail`);
    expect(slug).toBe("a".repeat(SLUG_MAX_LENGTH));
    expect(slugify(`${"b".repeat(SLUG_MAX_LENGTH - 1)} tail`)).toBe(
      "b".repeat(SLUG_MAX_LENGTH - 1),
    );
  });

  test("yields the empty string for a name with nothing sluggable", () => {
    expect(slugify("—!!—")).toBe("");
    expect(slugify("")).toBe("");
  });

  test("produces a valid slug for every non-empty result", () => {
    for (const name of [
      "Triage Bot",
      "Café Crème",
      "  --Weekly (report)! -- ",
      "Sprint 42 recap",
      `${"a".repeat(SLUG_MAX_LENGTH)} tail`,
    ]) {
      expect(isValidSlug(slugify(name))).toBe(true);
    }
  });
});

describe("isValidSlug", () => {
  test("accepts lowercase hyphen-joined words", () => {
    expect(isValidSlug("triage-bot")).toBe(true);
    expect(isValidSlug("sprint-42")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  test("rejects anything slugify would never produce", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Triage-Bot")).toBe(false);
    expect(isValidSlug("wfd_1")).toBe(false);
    expect(isValidSlug("-triage")).toBe(false);
    expect(isValidSlug("triage-")).toBe(false);
    expect(isValidSlug("triage--bot")).toBe(false);
    expect(isValidSlug("triage bot")).toBe(false);
    expect(isValidSlug("triage/bot")).toBe(false);
    expect(isValidSlug("café")).toBe(false);
  });

  test("rejects a slug past the length cap", () => {
    expect(isValidSlug("c".repeat(SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidSlug("c".repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
  });
});
