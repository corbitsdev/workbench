import { describe, expect, test } from "bun:test";
import {
  MCP_PRESET_CONNECTOR_IDS,
  MCP_PRESETS,
  mcpPresetByName,
  mcpPresetBySlug,
} from "./mcp-presets";
import { CONNECTOR_REGISTRY } from "./registry";

describe("MCP_PRESETS", () => {
  test("names Granola, Exa, and Linear with real Streamable HTTP URLs", () => {
    const slugs = MCP_PRESETS.map((preset) => preset.slug).sort();
    expect(slugs).toEqual(["exa", "granola", "linear"]);
    for (const preset of MCP_PRESETS) {
      expect(() => new URL(preset.url)).not.toThrow();
      expect(preset.url.startsWith("https://")).toBe(true);
    }
  });

  test("only Exa is marked key-optional", () => {
    const exa = mcpPresetBySlug("exa");
    expect(exa?.keyOptional).toBe(true);
    expect(mcpPresetBySlug("granola")?.keyOptional).toBe(false);
    expect(mcpPresetBySlug("linear")?.keyOptional).toBe(false);
  });

  test("every preset's nativeConnectorId names a real registry entry", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.nativeConnectorId === undefined) continue;
      expect(CONNECTOR_REGISTRY[preset.nativeConnectorId]).toBeDefined();
    }
  });

  test("MCP_PRESET_CONNECTOR_IDS matches the presets' native ids", () => {
    expect(new Set(MCP_PRESET_CONNECTOR_IDS)).toEqual(
      new Set(["granola", "exa", "linear"]),
    );
  });

  test("mcpPresetByName resolves by slug or display name, case-insensitively", () => {
    expect(mcpPresetByName("Exa")?.slug).toBe("exa");
    expect(mcpPresetByName("EXA")?.slug).toBe("exa");
    expect(mcpPresetByName("granola")?.slug).toBe("granola");
    expect(mcpPresetByName("nope")).toBeUndefined();
  });

  test("mcpPresetBySlug returns undefined for an unknown slug", () => {
    expect(mcpPresetBySlug("not-a-preset")).toBeUndefined();
  });
});
