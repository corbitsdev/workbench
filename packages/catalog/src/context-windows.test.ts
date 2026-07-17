import { describe, expect, test } from "bun:test";
import {
  contextWindowForModel,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-windows";
import { CATALOG_MODELS } from "./models";

describe("contextWindowForModel", () => {
  test("resolves known model ids to their catalog context window", () => {
    expect(contextWindowForModel("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowForModel("gpt-4.1")).toBe(1_047_576);
    expect(contextWindowForModel("deepseek-v4-flash")).toBe(1_000_000);
  });

  test("returns the conservative default for an unknown model id", () => {
    expect(contextWindowForModel("not-a-real-model")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  test("every catalog model carries a positive context window", () => {
    for (const model of CATALOG_MODELS) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(contextWindowForModel(model.canonicalName)).toBe(
        model.contextWindow,
      );
    }
  });
});
