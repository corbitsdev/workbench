import { describe, expect, test } from "bun:test";
import type { ResolvedOffering } from "@intx/db";
import type { Capability } from "@intx/types";
import { selectDefaultInferencePreferences } from "./inference-preferences";

function offering(
  overrides: Partial<{
    offeringId: string;
    priority: number;
    canonicalName: string;
    providerName: string;
    credentialId: string | null;
    capabilities: readonly Capability[];
    origin: ResolvedOffering["origin"];
  }> = {},
): ResolvedOffering {
  const {
    offeringId = "off_1",
    priority = 0,
    canonicalName = "claude-sonnet-5",
    providerName = "anthropic",
    credentialId = "cred_1",
    capabilities = ["plain-text"],
    origin = { tenantId: "tnt_bench", direct: true },
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
    origin,
  };
}

describe("workbench inherit parent ollama", () => {
  test("New child-tenant workbench + parent-space Ollama chat offering/credential only", () => {
    const inherited = offering({
      offeringId: "off_ollama_chat",
      priority: 0,
      canonicalName: "qwen3:8b",
      providerName: "ollama",
      credentialId: "cred_ollama",
      capabilities: ["plain-text"],
      origin: { tenantId: "tnt_parent", direct: false },
    });
    expect(selectDefaultInferencePreferences([inherited])).toEqual([
      { provider: "ollama", model: "qwen3:8b" },
    ]);
  });

  test("New child-tenant workbench + parent-space Ollama chat offering/credential only — inherited provider with no credential is not Connected", () => {
    const inherited = offering({
      offeringId: "off_ollama_chat",
      priority: 0,
      canonicalName: "qwen3:8b",
      providerName: "ollama",
      credentialId: null,
      capabilities: ["plain-text"],
      origin: { tenantId: "tnt_parent", direct: false },
    });
    expect(selectDefaultInferencePreferences([inherited])).toEqual([]);
  });
});
