import { describe, expect, test } from "bun:test";

import { PROVIDER_MODELS } from "./provider-models";

// Mirrors `grok models` on Grok Build CLI 1.0.46 (unauthenticated, served by
// the same cli-chat-proxy.grok.com the xai provider option mints offerings
// against): the default first, then the rest of the listed catalog.
const GROK_CLI_1_0_46_CATALOG = [
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
] as const;

describe("xai provider models", () => {
  test("matches the Grok Build CLI 1.0.46 proxy catalog, default first", () => {
    expect(PROVIDER_MODELS["xai"]).toEqual([...GROK_CLI_1_0_46_CATALOG]);
  });
});
