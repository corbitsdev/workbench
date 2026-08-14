// Proves `createChannelHostInferencePreferencesResolver` wires a
// per-tenant connected-provider lookup into an ordered inference
// preference list, without touching a database: `listConnected` here
// is a plain fake, so this only exercises the resolver's own wiring —
// `deriveChannelHostInferencePreferences`'s ordering rule is proven in
// `@workbench/hub-client`'s own tests.
import { describe, expect, test } from "bun:test";
import { createChannelHostInferencePreferencesResolver } from "./inference-preferences";

describe("createChannelHostInferencePreferencesResolver", () => {
  test("anthropic-only bench resolves to anthropic's curated default", async () => {
    const resolve = createChannelHostInferencePreferencesResolver(async () => [
      "anthropic",
    ]);
    expect(await resolve("tnt_bench")).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  test("openrouter-only bench resolves to an openrouter source, never anthropic", async () => {
    const resolve = createChannelHostInferencePreferencesResolver(async () => [
      "openrouter",
    ]);
    expect(await resolve("tnt_bench")).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    ]);
  });

  test("a multi-provider bench keeps anthropic first among the connected set", async () => {
    const resolve = createChannelHostInferencePreferencesResolver(async () => [
      "openrouter",
      "anthropic",
      "xai",
    ]);
    expect(await resolve("tnt_bench")).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "xai", model: "grok-4.6" },
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    ]);
  });

  test("a bench with no connected providers resolves to an empty list", async () => {
    const resolve = createChannelHostInferencePreferencesResolver(
      async () => [],
    );
    expect(await resolve("tnt_bench")).toEqual([]);
  });

  test("passes the tenant id through to the connected-provider lookup", async () => {
    const seen: string[] = [];
    const resolve = createChannelHostInferencePreferencesResolver(
      async (tenantId) => {
        seen.push(tenantId);
        return [];
      },
    );
    await resolve("tnt_specific");
    expect(seen).toEqual(["tnt_specific"]);
  });
});
