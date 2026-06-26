import { describe, expect, it } from "bun:test";
import { cn, toHumanLabel } from "./utils";

describe("cn", () => {
  it("joins truthy class names and drops falsy ones", () => {
    const omit = "" as string | false;
    expect(cn("a", omit && "b", undefined, null, "c")).toBe("a c");
  });

  it("merges conflicting tailwind utilities, keeping the last", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("flattens arrays and conditional objects", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });
});

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
