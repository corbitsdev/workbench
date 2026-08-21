import { describe, expect, test } from "bun:test";
import {
  OllamaAdapterConfig,
  parseOllamaAdapterConfig,
  resolveOverride,
} from "./overrides";

describe("parseOllamaAdapterConfig", () => {
  test("undefined quirks resolve to an empty config", () => {
    expect(parseOllamaAdapterConfig(undefined)).toEqual({});
  });

  test("rejects an unknown top-level key", () => {
    expect(() => parseOllamaAdapterConfig({ bogus: true })).toThrow();
  });

  test("rejects a non-positive numCtx", () => {
    expect(() =>
      parseOllamaAdapterConfig({ default: { numCtx: 0 } }),
    ).toThrow();
  });

  test("rejects a reasoningEffort outside the closed set", () => {
    expect(() =>
      parseOllamaAdapterConfig({ default: { reasoningEffort: "extreme" } }),
    ).toThrow();
  });

  test("accepts a well-formed default and perModel config", () => {
    const parsed = OllamaAdapterConfig({
      default: { numCtx: 8192 },
      perModel: { "gpt-oss:20b": { maxOutputTokens: 2048 } },
    });
    expect(parsed instanceof Error).toBe(false);
  });
});

describe("resolveOverride", () => {
  test("no override configured resolves to an empty override", () => {
    expect(resolveOverride({}, "gpt-oss:20b")).toEqual({});
  });

  test("the general default applies when no per-model entry matches", () => {
    const config = parseOllamaAdapterConfig({ default: { numCtx: 8192 } });
    expect(resolveOverride(config, "qwen3.8:27b")).toEqual({ numCtx: 8192 });
  });

  test("a per-model override beats the general default field-by-field", () => {
    const config = parseOllamaAdapterConfig({
      default: { numCtx: 8192, maxOutputTokens: 1024 },
      perModel: { "gpt-oss:20b": { numCtx: 32768 } },
    });
    expect(resolveOverride(config, "gpt-oss:20b")).toEqual({
      numCtx: 32768,
      maxOutputTokens: 1024,
    });
    expect(resolveOverride(config, "qwen3.8:27b")).toEqual({
      numCtx: 8192,
      maxOutputTokens: 1024,
    });
  });

  test("reasoningEffort resolves the same way", () => {
    const config = parseOllamaAdapterConfig({
      default: { reasoningEffort: "low" },
      perModel: { "gpt-oss:20b": { reasoningEffort: "high" } },
    });
    expect(resolveOverride(config, "gpt-oss:20b").reasoningEffort).toBe(
      "high",
    );
    expect(resolveOverride(config, "qwen3.8:27b").reasoningEffort).toBe(
      "low",
    );
  });
});
