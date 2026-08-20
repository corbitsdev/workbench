// Proves the workbench host uses the tenant's catalog route verbatim. The
// catalog is the shared source of truth the AI Providers UI edits: head is
// the global default, tail is the failover chain.
import { describe, expect, test } from "bun:test";
import { createWorkbenchHostInferencePreferencesResolver } from "./inference-preferences";

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
