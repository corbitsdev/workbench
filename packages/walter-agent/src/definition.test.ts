import { describe, expect, test } from "bun:test";
import {
  WALTER_AGENT_DEFINITION,
  WALTER_TOOL_PACKAGE_PINS,
} from "./definition";

describe("WALTER_AGENT_DEFINITION", () => {
  test("is plain, JSON-portable data", () => {
    expect(() => JSON.stringify(WALTER_AGENT_DEFINITION)).not.toThrow();
    expect(WALTER_AGENT_DEFINITION.id).toBe("walter");
    expect(WALTER_AGENT_DEFINITION.handle).toBe("walter");
  });

  test("needs no tool connections — a default teammate with nothing to set up", () => {
    expect(WALTER_TOOL_PACKAGE_PINS).toHaveLength(0);
  });

  test("never instructs a tool call it has no tool for", () => {
    const prompt = WALTER_AGENT_DEFINITION.systemPrompt;
    expect(prompt).not.toMatch(/artifact_link_file/i);
    expect(prompt).toMatch(/no tool to write files/i);
  });

  test("carries no project-specific names or endpoints", () => {
    const prompt = WALTER_AGENT_DEFINITION.systemPrompt;
    expect(prompt).not.toMatch(/gtm-workbench|corbits(?!\/)|sawyer/i);
  });
});
