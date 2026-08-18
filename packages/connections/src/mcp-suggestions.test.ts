import { describe, expect, test } from "bun:test";
import { MCP_PRESETS } from "./mcp-presets";
import { MCP_SUGGESTIONS, mcpSuggestionBySlug } from "./mcp-suggestions";

describe("MCP_SUGGESTIONS", () => {
  test("carries the roster names with no known-good or owner-supplied endpoint", () => {
    const slugs = MCP_SUGGESTIONS.map((s) => s.slug).sort();
    expect(slugs).toEqual(
      [
        "attio",
        "browserbase",
        "google",
        "hubspot",
        "notion",
        "posthog",
        "railway",
        "render",
        "sentry",
        "slack",
        "vercel",
        "zoom",
      ].sort(),
    );
  });

  test("never overlaps a curated preset's slug", () => {
    const presetSlugs = new Set(MCP_PRESETS.map((preset) => preset.slug));
    for (const suggestion of MCP_SUGGESTIONS) {
      expect(presetSlugs.has(suggestion.slug)).toBe(false);
    }
  });

  test("carries no url — a suggestion is not a connection", () => {
    for (const suggestion of MCP_SUGGESTIONS) {
      expect("url" in suggestion).toBe(false);
    }
  });

  test("mcpSuggestionBySlug resolves a known slug and returns undefined otherwise", () => {
    expect(mcpSuggestionBySlug("notion")?.displayName).toBe("Notion");
    expect(mcpSuggestionBySlug("not-a-thing")).toBeUndefined();
  });

  test("Attio, Browserbase, and Slack fall back to the initial tile (no simple-icons listing)", () => {
    for (const slug of ["attio", "browserbase", "slack"]) {
      expect(mcpSuggestionBySlug(slug)?.icon).toBeUndefined();
    }
  });
});
