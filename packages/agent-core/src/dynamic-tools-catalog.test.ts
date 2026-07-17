import { describe, expect, it } from "bun:test";
import { MYRA_TOOL_CATALOG } from "./dynamic-tools-catalog";

describe("MYRA_TOOL_CATALOG runtime", () => {
  it("builds catalog entries with humanized tool descriptions at module load", () => {
    expect(MYRA_TOOL_CATALOG.length).toBeGreaterThan(0);
    const firstTool = MYRA_TOOL_CATALOG[0]?.tools[0];
    expect(firstTool?.description).toBeTruthy();
    expect(firstTool?.description).not.toMatch(/^[a-z]+_[a-z]/);
  });

  it("widens the search corpus with real manifest descriptions in keywords", () => {
    const toolsWithKeywords = MYRA_TOOL_CATALOG.flatMap((e) => e.tools).filter(
      (t) => typeof t.keywords === "string" && t.keywords.length > 0,
    );
    expect(toolsWithKeywords.length).toBeGreaterThan(0);
    // keywords carry the real manifest description, not the friendly phrase.
    const differing = toolsWithKeywords.find(
      (t) => t.keywords !== t.description,
    );
    expect(differing).toBeDefined();
  });
});
