// Proves the workbench host uses the tenant's catalog route verbatim. The
// catalog is the shared source of truth the AI Providers UI edits: head is
// the global default, tail is the failover chain.
import { describe, expect, test } from "bun:test";
import type { ResolvedOffering } from "@intx/db";
import type { Capability } from "@intx/types";
import {
  createWorkbenchHostInferencePreferencesResolver,
  selectDefaultInferencePreferences,
} from "./inference-preferences";

function offering(
  overrides: Partial<{
    offeringId: string;
    priority: number;
    canonicalName: string;
    providerName: string;
    credentialId: string | null;
    capabilities: readonly Capability[];
  }> = {},
): ResolvedOffering {
  const {
    offeringId = "off_1",
    priority = 0,
    canonicalName = "claude-sonnet-5",
    providerName = "anthropic",
    credentialId = "cred_1",
    capabilities = ["plain-text"],
  } = overrides;
  return {
    offering: {
      id: offeringId,
      priority,
      capabilities,
    } as ResolvedOffering["offering"],
    model: { canonicalName } as ResolvedOffering["model"],
    provider: {
      name: providerName,
      credentialId,
    } as ResolvedOffering["provider"],
    origin: { tenantId: "tnt_bench", direct: true },
  };
}

describe("createWorkbenchHostInferencePreferencesResolver", () => {
  test("returns the catalog's primary and fallbacks without reordering", async () => {
    const resolve = createWorkbenchHostInferencePreferencesResolver(
      async () => [
        { provider: "openai-compatible", model: "grok-4.6" },
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
    );
    expect(await resolve("tnt_bench")).toEqual([
      { provider: "openai-compatible", model: "grok-4.6" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  test("a bench with no routed offerings resolves to an empty list", async () => {
    const resolve = createWorkbenchHostInferencePreferencesResolver(
      async () => [],
    );
    expect(await resolve("tnt_bench")).toEqual([]);
  });

  test("passes the tenant id through to the catalog route lookup", async () => {
    const seen: string[] = [];
    const resolve = createWorkbenchHostInferencePreferencesResolver(
      async (tenantId) => {
        seen.push(tenantId);
        return [];
      },
    );
    await resolve("tnt_specific");
    expect(seen).toEqual(["tnt_specific"]);
  });
});

describe("selectDefaultInferencePreferences", () => {
  test("excludes offerings with no resolvable credential", () => {
    const result = selectDefaultInferencePreferences([
      offering({ credentialId: null }),
    ]);
    expect(result).toEqual([]);
  });

  test("CL-6351: a fresh Ollama connect ties every pulled model at one priority -- resolution must skip the embedding model even when its name sorts first", () => {
    const result = selectDefaultInferencePreferences([
      offering({
        offeringId: "off_embed",
        canonicalName: "all-minilm",
        providerName: "ollama",
        priority: 0,
        capabilities: [],
      }),
      offering({
        offeringId: "off_chat",
        canonicalName: "qwen3:8b",
        providerName: "ollama",
        priority: 0,
        capabilities: ["plain-text"],
      }),
    ]);
    expect(result).toEqual([{ provider: "ollama", model: "qwen3:8b" }]);
  });

  test("CL-6351: an uncataloged embedding-named offering never wins even at the lowest priority, and never falls back to the unfiltered set", () => {
    const result = selectDefaultInferencePreferences([
      offering({
        offeringId: "off_embed",
        canonicalName: "all-minilm",
        providerName: "ollama",
        priority: 0,
        capabilities: [],
      }),
      offering({
        offeringId: "off_chat",
        canonicalName: "qwen3:8b",
        providerName: "ollama",
        priority: 1,
        capabilities: [],
      }),
    ]);
    expect(result).toEqual([{ provider: "ollama", model: "qwen3:8b" }]);
  });

  test("CL-6351: an offering set that is entirely uncataloged embedding-named models resolves to no default, never one of them", () => {
    const result = selectDefaultInferencePreferences([
      offering({
        offeringId: "off_embed_1",
        canonicalName: "all-minilm",
        providerName: "ollama",
        priority: 0,
        capabilities: [],
      }),
      offering({
        offeringId: "off_embed_2",
        canonicalName: "nomic-embed-text",
        providerName: "ollama",
        priority: 1,
        capabilities: [],
      }),
    ]);
    expect(result).toEqual([]);
  });

  test("returns every provider's offering of the winning model, sorted by priority", () => {
    const result = selectDefaultInferencePreferences([
      offering({
        offeringId: "off_a",
        canonicalName: "claude-sonnet-5",
        providerName: "anthropic",
        priority: 0,
      }),
      offering({
        offeringId: "off_b",
        canonicalName: "claude-sonnet-5",
        providerName: "opencode-zen",
        priority: 1,
      }),
    ]);
    expect(result).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "opencode-zen", model: "claude-sonnet-5" },
    ]);
  });
});
