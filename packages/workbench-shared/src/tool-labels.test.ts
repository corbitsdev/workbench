import { describe, expect, it } from "bun:test";
import { toHumanLabel } from "./tool-labels";

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
