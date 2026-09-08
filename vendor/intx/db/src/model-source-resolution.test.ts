// CL-7505 local delta: the serving-time refresh seam in `buildSource`. A
// provider-backed `oauth_token` credential is offered to the caller's
// `servingRefresh` hook before its secret is served: a hook that refreshed
// it in place re-reads the row and serves the fresh secret; a hook that
// reports the credential past saving skips the offering outright (never a
// dead secret in the material cell); an `api_key` credential never reaches
// the hook at all — its path is byte-for-byte what it was before the delta.
import { describe, expect, mock, test } from "bun:test";
import type { CredentialCipher } from "@intx/types";

const resolvedRows: Record<
  string,
  {
    id: string;
    tenantId: string;
    providerId: string;
    principalId: string | null;
    type: string;
    status: string;
    secret: string;
    refreshSecret: string | null;
    expiresAt: Date | null;
  }
> = {};

mock.module("./credential-resolution", () => ({
  resolveCredentialById: async (_db: unknown, _tenantId: string, id: string) =>
    resolvedRows[id] ?? null,
}));

mock.module("./parse-row", () => ({
  parseModelOfferingRow: (row: Record<string, unknown>) => ({
    ...row,
    capabilities: [],
    quirks: (row.quirks as unknown) ?? null,
  }),
}));

import { buildSource, type ServingRefresh } from "./model-source-resolution";

const offering = {
  offering: {
    id: "off_1",
    priority: 0,
    capabilities: [],
  },
  provider: {
    id: "prov_1",
    name: "test-provider",
    plugin: "test-plugin",
    baseURL: "https://inference.invalid",
    credentialId: "cred_1",
    walletId: null,
  },
  model: { canonicalName: "test-model" },
} as unknown as Parameters<typeof buildSource>[2];

const cipher = {
  decrypt: async (secret: string) => `plain:${secret}`,
} as unknown as CredentialCipher;

function row(type: string) {
  return {
    id: "cred_1",
    tenantId: "ten_1",
    providerId: "prov_1",
    principalId: null,
    type,
    status: "active",
    secret: "enc:old",
    refreshSecret: type === "oauth_token" ? "enc:refresh" : null,
    expiresAt: type === "oauth_token" ? new Date(0) : null,
  };
}

describe("buildSource servingRefresh seam (CL-7505)", () => {
  test("an expiring oauth_token is refreshed and the fresh secret served", async () => {
    resolvedRows["cred_1"] = row("oauth_token");
    const hook: ServingRefresh = async () => {
      resolvedRows["cred_1"] = {
        ...resolvedRows["cred_1"]!,
        secret: "enc:new",
        expiresAt: new Date(9_999),
      };
      return { ok: true };
    };
    const built = await buildSource({} as never, "ten_1", offering, cipher, {
      servingRefresh: hook,
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.material.secret).toBe("plain:enc:new");
  });

  test("a credential the hook cannot save is skipped, never served", async () => {
    resolvedRows["cred_1"] = row("oauth_token");
    const hook: ServingRefresh = async () => ({
      ok: false,
      message: "refresh_token revoked",
    });
    const built = await buildSource({} as never, "ten_1", offering, cipher, {
      servingRefresh: hook,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.skip.reason).toBe("credential_needs_reauth");
    }
  });

  test("an api_key credential never reaches the hook and serves as before", async () => {
    resolvedRows["cred_1"] = row("api_key");
    let hookCalls = 0;
    const hook: ServingRefresh = async () => {
      hookCalls += 1;
      return { ok: true };
    };
    const built = await buildSource({} as never, "ten_1", offering, cipher, {
      servingRefresh: hook,
    });
    expect(hookCalls).toBe(0);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.material.secret).toBe("plain:enc:old");
  });
});

// CL-7510 local delta: provider-name → adapter-registry-key dispatch. The
// catalog `plugin` column stays the wire-format id ("openai-responses" for
// the loopback-OAuth providers, "openai-compatible" for Ollama); only the
// launched InferenceSource.provider is rewritten to the key the sidecar's
// DEFAULT_ADAPTER_MANIFEST registers the custom factory under.
describe("buildSource adapter registry-key dispatch (CL-7510)", () => {
  resolvedRows["cred_1"] = row("api_key");

  test("a codex offering dispatches under the codex registry key with its quirks threaded", async () => {
    const codexOffering = {
      offering: {
        id: "off_codex",
        priority: 0,
        capabilities: [],
        quirks: {
          productName: "Codex",
          environmentTagName: "codex_environment",
        },
      },
      provider: {
        id: "prov_codex",
        name: "codex",
        plugin: "openai-responses",
        baseURL: "https://chatgpt.com/backend-api",
        credentialId: "cred_1",
        walletId: null,
      },
      model: { canonicalName: "gpt-5.5" },
    } as unknown as Parameters<typeof buildSource>[2];

    const built = await buildSource({} as never, "ten_1", codexOffering, cipher);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.source.provider).toBe("codex");
      expect(built.source.quirks).toEqual({
        productName: "Codex",
        environmentTagName: "codex_environment",
      });
      expect(built.source.baseURL).toBe("https://chatgpt.com/backend-api");
    }
  });

  test("an xai-oauth offering dispatches under the xai-oauth registry key", async () => {
    const xaiOffering = {
      offering: { id: "off_xai", priority: 0, capabilities: [] },
      provider: {
        id: "prov_xai",
        name: "xai-oauth",
        plugin: "openai-responses",
        baseURL: "https://cli-chat-proxy.grok.com/v1",
        credentialId: "cred_1",
        walletId: null,
      },
      model: { canonicalName: "grok-4.6" },
    } as unknown as Parameters<typeof buildSource>[2];

    const built = await buildSource({} as never, "ten_1", xaiOffering, cipher);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.source.provider).toBe("xai-oauth");
  });

  test("every other provider keeps its plugin as the dispatch key", async () => {
    const built = await buildSource({} as never, "ten_1", offering, cipher);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.source.provider).toBe("test-plugin");
      expect(built.material.providerKey).toBe("test-plugin");
    }
  });
});
