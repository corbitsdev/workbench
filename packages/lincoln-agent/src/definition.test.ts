import { describe, expect, test } from "bun:test";
import { WEB_SEARCH_TOOL } from "@corbits/web-search-tools";
import {
  LINCOLN_AGENT_DEFINITION,
  LINCOLN_TOOL_PACKAGE_PINS,
} from "./definition";

describe("LINCOLN_AGENT_DEFINITION", () => {
  test("is plain, JSON-portable data", () => {
    expect(() => JSON.stringify(LINCOLN_AGENT_DEFINITION)).not.toThrow();
    expect(LINCOLN_AGENT_DEFINITION.id).toBe("lincoln");
    expect(LINCOLN_AGENT_DEFINITION.handle).toBe("lincoln");
  });

  test("pins the workbench web-search tool, not the original's firecrawl tools", () => {
    const names = LINCOLN_TOOL_PACKAGE_PINS.map((pin) => pin.name);
    expect(names).toContain("@corbits/web-search-tools");
    expect(names).not.toContain("@corbits/firecrawl-tools");
  });

  test("never instructs the retired firecrawl tool calls", () => {
    const prompt = LINCOLN_AGENT_DEFINITION.systemPrompt;
    expect(prompt).not.toMatch(/firecrawl/i);
    expect(prompt).toContain(WEB_SEARCH_TOOL);
  });

  test("degrades honestly when web search isn't connected, never silently", () => {
    const prompt = LINCOLN_AGENT_DEFINITION.systemPrompt;
    expect(prompt).toMatch(/isn't connected/i);
    expect(prompt).toMatch(/draft from the conversation/i);
  });

  test("carries no project-specific names or endpoints", () => {
    const prompt = LINCOLN_AGENT_DEFINITION.systemPrompt;
    expect(prompt).not.toMatch(/gtm-workbench|corbits(?!\/)|sawyer/i);
  });
});
