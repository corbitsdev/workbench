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
    ["x_search", "X Search"],
    ["granola_list_notes", "List Notes"],
    ["firecrawl_scrape", "Scrape"],
    ["exa_search", "Search"],
    ["exa_firecrawl_test", "Firecrawl Test"],
    ["pending_review", "Pending Review"],
    ["call-transcript", "Call Transcript"],
    ["ToolCall", "Tool Call"],
    ["linkedin-post", "LinkedIn Post"],
    ["founder-pov-post", "Founder POV Post"],
  ])("formats %s as %s", (input, expected) => {
    expect(toHumanLabel(input)).toBe(expected);
  });
});
