import { describe, expect, it } from "bun:test";
import { toHumanLabel, skillTitle } from "./tool-labels";

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
});
