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
    quirks: null,
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
