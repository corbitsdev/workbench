import { describe, expect, it } from "bun:test";
import { toHumanLabel, skillTitle, toAssetName } from "./tool-labels";

describe("toHumanLabel", () => {
  it.each([
    ["", ""],
    ["search", "Search"],
    ["x_search", "X search"],
    ["granola_list_notes", "List notes"],
    ["firecrawl_scrape", "Scrape"],
    ["exa_search", "Search"],
    ["exa_firecrawl_test", "Firecrawl test"],
    ["pending_review", "Pending review"],
    ["call-transcript", "Call transcript"],
    ["ToolCall", "Tool call"],
    ["linkedin-post", "LinkedIn post"],
    ["founder-pov-post", "Founder POV post"],
  ])("formats %s as %s", (input, expected) => {
    expect(toHumanLabel(input)).toBe(expected);
  });
});

describe("skillTitle", () => {
  it("humanizes a slug-shaped displayName stored verbatim at creation", () => {
    expect(
      skillTitle({ name: "landing-page", displayName: "landing-page" }),
    ).toBe("Landing page");
  });

  it("leaves a real human title unchanged", () => {
    expect(
      skillTitle({ name: "company-research", displayName: "Company Research" }),
    ).toBe("Company Research");
  });

  it("humanizes the name when displayName is null", () => {
    expect(skillTitle({ name: "viral-content", displayName: null })).toBe(
      "Viral content",
    );
  });

  it("humanizes a single-word slug displayName", () => {
    expect(skillTitle({ name: "asap", displayName: "asap" })).toBe("Asap");
  });

  it("humanizes a slug-shaped displayName longer than the 64-char asset-name cap", () => {
    const longSlug = `${"a".repeat(40)}-${"b".repeat(40)}`;
    expect(longSlug.length).toBeGreaterThan(64);
    expect(skillTitle({ name: "long", displayName: longSlug })).toBe(
      toHumanLabel(longSlug),
    );
  });
});

describe("toAssetName", () => {
  it("lowercases and kebab-cases a display name", () => {
    expect(toAssetName("My ASAP Skill")).toBe("my-asap-skill");
  });

  it("collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(toAssetName("Skill: (v2) -- final!")).toBe("skill-v2-final");
  });

  it("strips leading and trailing hyphens", () => {
    expect(toAssetName("---skill---")).toBe("skill");
  });

  it('falls back to "skill" for a blank or symbol-only name', () => {
    expect(toAssetName("")).toBe("skill");
    expect(toAssetName("!!!")).toBe("skill");
  });

  it("truncates to 64 characters", () => {
    expect(toAssetName("a".repeat(100))).toHaveLength(64);
  });
});
