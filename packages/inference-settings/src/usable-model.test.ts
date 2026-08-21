import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@intx/types";
import { hasUsableModel } from "./usable-model";

function modelWithOfferings(offeringCount: number): ModelInfo {
  return {
    id: "model_1",
    canonicalName: "claude-opus",
    displayName: "Opus",
    offerings: Array.from({ length: offeringCount }, (_, index) => ({
      offeringId: `off_${index}`,
      providerId: "prov_1",
      providerName: "anthropic",
      plugin: "anthropic",
      priority: index,
      capabilities: [],
    })),
  } as unknown as ModelInfo;
}

describe("hasUsableModel", () => {
  test("false for an empty resolved catalog", () => {
    expect(hasUsableModel([])).toBe(false);
  });

  test("false when every model resolved with zero offerings", () => {
    // Mirrors a seeded `model_provider` row with no credential: the
    // platform's own resolution (`resolveModelSources`) excludes it, so a
    // model that somehow carries no offerings is exactly as unusable as
    // no model at all — never trust the row's mere presence.
    expect(hasUsableModel([modelWithOfferings(0)])).toBe(false);
  });

  test("true once at least one model resolves at least one offering", () => {
    expect(hasUsableModel([modelWithOfferings(1)])).toBe(true);
  });
});
