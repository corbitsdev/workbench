import { describe, expect, test } from "bun:test";
import { LOOP_AGENT_DEFINITION, LOOP_TOOL_PACKAGE_PINS } from "./definition";

describe("LOOP_AGENT_DEFINITION", () => {
  test("is plain, JSON-portable data", () => {
    expect(() => JSON.stringify(LOOP_AGENT_DEFINITION)).not.toThrow();
    expect(LOOP_AGENT_DEFINITION.id).toBe("loop");
    expect(LOOP_AGENT_DEFINITION.handle).toBe("loop");
  });

  test("needs no tool connections — a default teammate with nothing to set up", () => {
    expect(LOOP_TOOL_PACKAGE_PINS).toHaveLength(0);
  });

  test("never claims a web-search or memory tool it doesn't have", () => {
    const prompt = LOOP_AGENT_DEFINITION.systemPrompt;
    expect(prompt).toMatch(/no tool to search the web or persist notes/i);
  });

  test("carries no project-specific names or endpoints", () => {
    const prompt = LOOP_AGENT_DEFINITION.systemPrompt;
    expect(prompt).not.toMatch(/gtm-workbench|corbits(?!\/)|sawyer/i);
  });
});
