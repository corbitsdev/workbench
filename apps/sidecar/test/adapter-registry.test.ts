// Proves the default sidecar boot -- no `SIDECAR_ADAPTER_MANIFEST` set --
// actually registers `@corbits/ollama-adapter` for the `ollama` provider
// key, and that a seeded Ollama model's `quirks.numCtx` reaches the built
// request as `options.num_ctx`. Before this fix, `SIDECAR_ADAPTER_MANIFEST`
// defaulted to `[]`, so a default deployment resolved the built-in OpenAI
// adapter for `ollama` sources and never sent `num_ctx` at all.
import { expect, test } from "bun:test";
import { loadAdapterRegistry } from "@intx/inference/providers";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";

import { readSidecarConfig } from "../src/config";

const VALID_ENV = {
  SIDECAR_DATA_DIR: "/var/lib/sidecar",
  HUB_WS_URL: "wss://hub.example.com/api/sidecars/ws",
  SIDECAR_ID: "sidecar-1",
  SIDECAR_TOKEN: "secret-token",
  PATH: "/usr/local/bin:/usr/bin",
};

test("a default boot (no SIDECAR_ADAPTER_MANIFEST) registers the ollama provider", async () => {
  const config = readSidecarConfig(VALID_ENV);
  const registry = await loadAdapterRegistry(config.adapterManifest);

  expect(registry.has("ollama")).toBe(true);
});

test("a seeded Ollama model's quirks.numCtx reaches the built request as options.num_ctx, with no operator configuration", async () => {
  const config = readSidecarConfig(VALID_ENV);
  const registry = await loadAdapterRegistry(config.adapterManifest);

  const source: LastCycleSource = {
    sourceId: "src_1",
    provider: "ollama",
    model: "gpt-oss:20b",
  };
  // Shaped exactly like `@corbits/hub-client`'s seed writes onto a
  // catalog offering's `quirks` column (`quirksForDeployment`).
  const quirks = { default: { numCtx: 32_768 } };
  const adapter = registry.resolve(source, quirks);

  const messages: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
  ];
  const built = adapter.buildRequest(messages, "gpt-oss:20b", {});
  const body = JSON.parse(built.body) as { options?: { num_ctx?: number } };

  expect(body.options?.num_ctx).toBe(32_768);
});
