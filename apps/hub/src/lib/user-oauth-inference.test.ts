import { describe, expect, test } from "bun:test";
import type { InferenceSource } from "@intx/types/runtime";
import { mergeUserOAuthSources } from "./user-oauth-inference";

function src(
  id: string,
  model: string,
  provider = "openai-compatible",
): InferenceSource {
  return {
    id,
    provider,
    baseURL: "https://example.test",
    apiKey: "k",
    model,
  };
}

describe("mergeUserOAuthSources", () => {
  test("returns catalog when no oauth sources", () => {
    const catalog = [src("c1", "gpt-5.5")];
    expect(mergeUserOAuthSources(catalog, [])).toEqual(catalog);
  });

  test("returns oauth when no catalog sources", () => {
    const oauth = [src("o1", "grok-4.5", "grok-responses")];
    expect(mergeUserOAuthSources([], oauth)).toEqual(oauth);
  });

  test("prefers oauth sources for the same model, then catalog", () => {
    const catalog = [
      src("c-gpt", "gpt-5.5"),
      src("c-grok", "grok-4.5"),
    ];
    const oauth = [src("o-grok", "grok-4.5", "grok-responses")];
    const merged = mergeUserOAuthSources(catalog, oauth);
    expect(merged.map((s) => s.id)).toEqual([
      "c-gpt",
      "o-grok",
      "c-grok",
    ]);
  });

  test("appends oauth-only models after catalog model order", () => {
    const catalog = [src("c1", "gpt-5.5")];
    const oauth = [
      src("o-codex", "gpt-5.6-sol", "codex-responses"),
      src("o-gpt", "gpt-5.5", "codex-responses"),
    ];
    const merged = mergeUserOAuthSources(catalog, oauth);
    expect(merged.map((s) => s.id)).toEqual([
      "o-gpt",
      "c1",
      "o-codex",
    ]);
  });
});
