import { describe, expect, test } from "bun:test";
import { SCOUT_AGENT_DEFINITION, SCOUT_TOOL_PACKAGE_PINS } from "./definition";

describe("SCOUT_AGENT_DEFINITION", () => {
  test("is plain, JSON-portable data", () => {
    expect(() => JSON.stringify(SCOUT_AGENT_DEFINITION)).not.toThrow();
    expect(SCOUT_AGENT_DEFINITION.id).toBe("scout");
    expect(SCOUT_AGENT_DEFINITION.handle).toBe("scout");
  });

  test("pins the tool packages Scout's prompt actually depends on", () => {
    const names = SCOUT_TOOL_PACKAGE_PINS.map((pin) => pin.name);
    expect(names).toContain("@corbits/memory-tools");
    expect(names).toContain("@corbits/web-search-tools");
    expect(names).toContain("@corbits/scout-agent");
  });

  test("never promises the deferred diligence-brief or fact-check tools", () => {
    const prompt = SCOUT_AGENT_DEFINITION.systemPrompt;
    // The tool names themselves must never appear — those tools don't exist.
    expect(prompt).not.toMatch(/launch-diligence-brief/i);
    expect(prompt).not.toMatch(/launch-fact-check/i);
    // The prompt must disclaim the capability rather than staying silent
    // and letting the model promise a brief it can't produce.
    expect(prompt).toMatch(/cannot launch a multi-step diligence brief/i);
  });

  test("names every tool it actually declares", () => {
    const prompt = SCOUT_AGENT_DEFINITION.systemPrompt;
    for (const toolName of [
      "memory_search",
      "memory_add",
      "memory_list",
      "web_search",
      "save_artifact",
      "list_recent_artifacts",
    ]) {
      expect(prompt).toContain(toolName);
    }
  });
});
