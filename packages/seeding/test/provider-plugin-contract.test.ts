// The boundary the CL-7510 OAuth-only providers actually cross: the real
// `@intx/types` CreateModelProvider validator (the one the hub's
// model-providers POST route enforces) and `@intx/db`'s
// `parseModelProviderRow` (the one every read applies) must both accept the
// `openai-responses` plugin id the codex/xai-oauth seeds carry — the fake
// API in the seedCatalog tests accepts everything, so this is the only
// test that proves a real-token seed would not 400 at create time or
// throw at read time.
import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { CreateModelProvider, ModelProviderPlugin } from "@intx/types";
import { parseModelProviderRow } from "../../../vendor/intx/db/src/parse-row";
import type { modelProvider } from "../../../vendor/intx/db/src/schema";

describe("openai-responses plugin id contract", () => {
  test("CreateModelProvider accepts a codex-shaped provider body", () => {
    const parsed = CreateModelProvider({
      name: "codex",
      plugin: "openai-responses",
      baseURL: "https://chatgpt.com/backend-api",
      credentialId: "cre_1",
    });
    expect(!(parsed instanceof type.errors)).toBe(true);
  });

  test("ModelProviderPlugin still rejects an unknown plugin id", () => {
    expect(
      ModelProviderPlugin("openai-responses-future") instanceof type.errors,
    ).toBe(true);
  });

  test("parseModelProviderRow round-trips the new plugin id", () => {
    const row = {
      id: "mpr_1",
      tenantId: "tnt_1",
      name: "xai-oauth",
      plugin: "openai-responses",
      baseURL: "https://cli-chat-proxy.grok.com/v1",
      credentialId: "cre_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as typeof modelProvider.$inferSelect;
    expect(parseModelProviderRow(row).plugin).toBe("openai-responses");
  });
});
