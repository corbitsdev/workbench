import { describe, expect, test } from "bun:test";
import { WIRE_CAPABILITIES } from "@intx/types";

import { capabilitiesForDeployment } from "./offering-capabilities";

const vocabulary = new Set<string>(WIRE_CAPABILITIES);

describe("capabilitiesForDeployment", () => {
  test("a probed deployment reports what the catalog observed on it", () => {
    const resolved = capabilitiesForDeployment({
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com",
      canonicalName: "claude-sonnet-5",
    });
    expect(resolved.provenance).toBe("exact-deployment");
    expect(resolved.capabilities).toContain("plain-text");
    expect(resolved.capabilities).toContain("function-calling-multi-turn");
  });

  test("a relay of a model probed on the same wire inherits the shared floor", () => {
    const resolved = capabilitiesForDeployment({
      plugin: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      canonicalName: "openai/gpt-5.6-sol",
    });
    expect(resolved.provenance).toBe("same-model-wire");
    expect(resolved.capabilities.length).toBeGreaterThan(0);
  });

  test("a Claude model relayed over the OpenAI wire never inherits the native adapter's list", () => {
    const resolved = capabilitiesForDeployment({
      plugin: "openai-compatible",
      baseURL: "https://opencode.ai/zen/v1",
      canonicalName: "claude-sonnet-5",
    });
    expect(resolved.provenance).toBe("unknown");
    expect(resolved.capabilities).toEqual([]);
  });

  test("an unprobed local deployment says it does not know, rather than guessing", () => {
    const resolved = capabilitiesForDeployment({
      plugin: "openai-compatible",
      baseURL: "http://localhost:11434/v1",
      canonicalName: "qwen3.8:27b",
    });
    expect(resolved).toEqual({ capabilities: [], provenance: "unknown" });
  });

  test("every capability it ever reports is in the platform vocabulary", () => {
    for (const deployment of [
      {
        plugin: "anthropic",
        baseURL: "https://api.anthropic.com",
        canonicalName: "claude-opus-5",
      },
      {
        plugin: "openai",
        baseURL: "https://api.openai.com/v1",
        canonicalName: "gpt-4o-mini",
      },
      {
        plugin: "google-genai",
        baseURL: "https://generativelanguage.googleapis.com",
        canonicalName: "gemini-2.5-flash",
      },
      {
        plugin: "openai-compatible",
        baseURL: "https://api.x.ai/v1",
        canonicalName: "grok-4.6",
      },
    ]) {
      for (const capability of capabilitiesForDeployment(deployment)
        .capabilities) {
        expect(vocabulary.has(capability)).toBe(true);
      }
    }
  });
});
