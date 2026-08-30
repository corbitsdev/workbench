// The sweep's own orchestration — claim, mail, skip a no-recipient
// expiry, never double-claim, and (CL-6207) refresh-or-fail-loudly an
// MCP oauth_token credential — against an in-memory store. Which
// Hugging-Face-style credentials are due is `@corbits/notify`'s own
// tested concern (`findDueCredentialExpiries`); this only checks the
// loop calls it correctly and behaves once a claim or refresh decision
// comes back.
import { describe, expect, test } from "bun:test";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import {
  tickCredentialExpirySweep,
  type CredentialExpirySweepStore,
  type RefreshableMcpCredential,
} from "../src/credential-expiry-sweep";
import type { ExpiringCredential } from "@corbits/notify";
import type { McpOAuthRefreshResult } from "@workbench/connections";

const HUB_URL = "http://hub.test";

type MutableExpiringCredential = {
  -readonly [K in keyof ExpiringCredential]: ExpiringCredential[K];
};

function credential(
  overrides: Partial<ExpiringCredential> = {},
): MutableExpiringCredential {
  return {
    credentialId: "cred_1",
    tenantId: "tnt_1",
    providerId: "huggingface",
    providerLabel: "Hugging Face",
    status: "active",
    expiresAt: "2026-08-13T11:00:00.000Z",
    recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
    ...overrides,
  };
}

/** A raw row shape covering both credential kinds this sweep looks at —
 * only an `oauth_token` row with a `refreshSecret` should ever surface
 * through `loadRefreshableMcpCandidates`, mirroring the real Drizzle
 * store's `eq(credential.type, "oauth_token")` + `isNotNull(refreshSecret)`
 * filter. */
type McpCredentialRow = {
  credentialId: string;
  tenantId: string;
  slug: string;
  name: string;
  serverUrl: string;
  type: "api_key" | "oauth_token";
  refreshSecret: string | undefined;
  accessToken: string;
  status: "active" | "expired";
  recipients: readonly { tenantId: string; principalId: string }[];
};

function mcpCredential(
  overrides: Partial<McpCredentialRow> = {},
): McpCredentialRow {
  return {
    credentialId: "cred_mcp_1",
    tenantId: "tnt_1",
    slug: "granola",
    name: "Granola",
    serverUrl: "https://mcp.granola.example/mcp",
    type: "oauth_token",
    refreshSecret: "refresh_old",
    accessToken: "access_old",
    status: "active",
    recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
    ...overrides,
  };
}

function inMemoryStore(
  candidates: MutableExpiringCredential[],
  mcpRows: McpCredentialRow[] = [],
): CredentialExpirySweepStore & {
  claims: string[];
  mcpClaims: string[];
  mcpRefreshes: {
    credentialId: string;
    accessToken: string;
    refreshSecret: string | undefined;
  }[];
} {
  const claims: string[] = [];
  const mcpClaims: string[] = [];
  const mcpRefreshes: {
    credentialId: string;
    accessToken: string;
    refreshSecret: string | undefined;
  }[] = [];
  return {
    claims,
    mcpClaims,
    mcpRefreshes,
    async loadActiveCandidates() {
      return candidates.filter((c) => c.status === "active");
    },
    async claimExpiry(credentialId) {
      // Emulate a conditional DB update: only succeeds once per credential.
      const found = candidates.find(
        (c) => c.credentialId === credentialId && c.status === "active",
      );
      if (found) {
        claims.push(credentialId);
        found.status = "expired";
        return true;
      }
      const foundMcp = mcpRows.find(
        (r) => r.credentialId === credentialId && r.status === "active",
      );
      if (!foundMcp) return false;
      mcpClaims.push(credentialId);
      foundMcp.status = "expired";
      return true;
    },
    async loadRefreshableMcpCandidates(): Promise<
      readonly RefreshableMcpCredential[]
    > {
      return mcpRows
        .filter(
          (r) =>
            r.status === "active" &&
            r.type === "oauth_token" &&
            r.refreshSecret !== undefined,
        )
        .map((r) => ({
          credentialId: r.credentialId,
          tenantId: r.tenantId,
          slug: r.slug,
          name: r.name,
          serverUrl: r.serverUrl,
          tokens: {
            access_token: r.accessToken,
            token_type: "bearer",
            refresh_token: r.refreshSecret,
          },
          recipients: r.recipients,
        }));
    },
    async applyMcpRefresh(credentialId, _tenantId, tokens) {
      const found = mcpRows.find(
        (r) => r.credentialId === credentialId && r.status === "active",
      );
      if (!found) return false;
      mcpRefreshes.push({
        credentialId,
        accessToken: tokens.access_token,
        refreshSecret: tokens.refresh_token,
      });
      found.accessToken = tokens.access_token;
      found.refreshSecret = tokens.refresh_token;
      return true;
    },
  };
}

function notifyDeps(): NotifyDeliveryDeps & {
  mailed: { tenantId: string; principalId: string }[];
} {
  const mailed: { tenantId: string; principalId: string }[] = [];
  return {
    mailed,
    mail: async (items, opts) =>
      items.map((item, index) => {
        const id = `mail-${index}`;
        mailed.push({ tenantId: item.tenantId, principalId: item.principalId });
        opts?.enqueue?.({ id, item });
        return { messageKey: item.externalId, id };
      }),
    addressing: {
      inbox: (recipient) => `${recipient.principalId}@inbox.invalid`,
      from: (kind) => `${kind}@notify.invalid`,
    },
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
}

/** A notify deps whose `mail` throws — simulates a Postgres blip after a
 * credential has already been found due for expiry. */
function throwingNotifyDeps(error: Error): NotifyDeliveryDeps & {
  mailed: { tenantId: string; principalId: string }[];
} {
  return {
    mailed: [],
    mail: async () => {
      throw error;
    },
    addressing: {
      inbox: (recipient) => `${recipient.principalId}@inbox.invalid`,
      from: (kind) => `${kind}@notify.invalid`,
    },
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
}

/** A notify deps whose `mail` always dedupes — simulates a retry tick
 * re-mailing a credential whose notification already went out. */
function dedupingNotifyDeps(): NotifyDeliveryDeps & {
  mailed: { tenantId: string; principalId: string }[];
} {
  return {
    mailed: [],
    mail: async (items) =>
      items.map((item) => ({ messageKey: item.externalId, id: null })),
    addressing: {
      inbox: (recipient) => `${recipient.principalId}@inbox.invalid`,
      from: (kind) => `${kind}@notify.invalid`,
    },
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
}

const now = new Date("2026-08-13T12:00:00.000Z");

describe("tickCredentialExpirySweep", () => {
  test("claims a due credential and mails its recipients", async () => {
    const store = inMemoryStore([credential()]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual(["cred_1"]);
    expect(notify.mailed).toEqual([
      { tenantId: "tnt_1", principalId: "prn_1" },
    ]);
  });

  test("a credential with no active recipients is never claimed, staying due for a later tick", async () => {
    const store = inMemoryStore([credential({ recipients: [] })]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });

  test("a mail failure leaves the credential unclaimed instead of expiring it silently", async () => {
    const store = inMemoryStore([credential()]);
    const notify = throwingNotifyDeps(new Error("postgres blip"));

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual([]);

    // The next tick sees it still `active` and can finish the job.
    const retryNotify = notifyDeps();
    await tickCredentialExpirySweep({
      store,
      notify: retryNotify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual(["cred_1"]);
    expect(retryNotify.mailed).toEqual([
      { tenantId: "tnt_1", principalId: "prn_1" },
    ]);
  });

  test("a mail that dedupes (already sent by a prior tick) still claims the credential", async () => {
    const store = inMemoryStore([credential()]);
    const notify = dedupingNotifyDeps();

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual(["cred_1"]);
  });

  test("one candidate's mail failure does not abandon the rest of the tick", async () => {
    const store = inMemoryStore([
      credential({ credentialId: "cred_1" }),
      credential({ credentialId: "cred_2" }),
    ]);
    const mailed: { tenantId: string; principalId: string }[] = [];
    const notify: NotifyDeliveryDeps = {
      mail: async (items, opts) => {
        if (items[0]?.externalId === "cred_1") {
          throw new Error("postgres blip");
        }
        return items.map((item, index) => {
          const id = `mail-${index}`;
          mailed.push({
            tenantId: item.tenantId,
            principalId: item.principalId,
          });
          opts?.enqueue?.({ id, item });
          return { messageKey: item.externalId, id };
        });
      },
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.invalid`,
        from: (kind) => `${kind}@notify.invalid`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    };

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual(["cred_2"]);
    expect(mailed).toEqual([{ tenantId: "tnt_1", principalId: "prn_1" }]);
  });

  test("a credential not yet expired is neither claimed nor mailed", async () => {
    const store = inMemoryStore([
      credential({ expiresAt: "2026-08-13T13:00:00.000Z" }),
    ]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });

  test("a claim that loses the race (another replica already won) is never mailed", async () => {
    const store = inMemoryStore([credential()]);
    // Simulate another replica claiming first, between load and claim.
    await store.claimExpiry("cred_1", now);
    store.claims.length = 0;
    const notify = notifyDeps();

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      now: () => now,
    });

    expect(store.claims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });
});

describe("tickCredentialExpirySweep — MCP oauth_token refresh (CL-6207)", () => {
  test("an expiring mcp oauth credential is refreshed via the SDK and persisted, never mailed", async () => {
    const store = inMemoryStore([], [mcpCredential()]);
    const notify = notifyDeps();
    let calledWith:
      | Parameters<
          NonNullable<
            Parameters<typeof tickCredentialExpirySweep>[0]["refreshMcpTokens"]
          >
        >[0]
      | undefined;
    const refreshMcpTokens = async (
      args: Parameters<
        NonNullable<
          Parameters<typeof tickCredentialExpirySweep>[0]["refreshMcpTokens"]
        >
      >[0],
    ): Promise<McpOAuthRefreshResult> => {
      calledWith = args;
      return {
        ok: true,
        tokens: {
          access_token: "access_new",
          token_type: "bearer",
          refresh_token: "refresh_new",
          expires_in: 3600,
        },
      };
    };

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(calledWith?.serverUrl).toBe("https://mcp.granola.example/mcp");
    expect(calledWith?.tokens.refresh_token).toBe("refresh_old");
    expect(calledWith?.callbackUrl).toBe(
      `${HUB_URL}/api/tenants/tnt_1/mcp-servers/oauth/granola/callback`,
    );
    expect(store.mcpRefreshes).toEqual([
      {
        credentialId: "cred_mcp_1",
        accessToken: "access_new",
        refreshSecret: "refresh_new",
      },
    ]);
    expect(store.mcpClaims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });

  test("a failed refresh is claimed and mailed as a reconnect nudge, never swallowed", async () => {
    const store = inMemoryStore([], [mcpCredential()]);
    const notify = notifyDeps();
    const refreshMcpTokens = async (): Promise<McpOAuthRefreshResult> => ({
      ok: false,
      message: "invalid_grant: refresh token revoked",
    });

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(store.mcpClaims).toEqual(["cred_mcp_1"]);
    expect(store.mcpRefreshes).toEqual([]);
    expect(notify.mailed).toEqual([
      { tenantId: "tnt_1", principalId: "prn_1" },
    ]);
  });

  test("a failed refresh with no active recipients is never claimed, staying due for a later tick", async () => {
    const store = inMemoryStore([], [mcpCredential({ recipients: [] })]);
    const notify = notifyDeps();
    const refreshMcpTokens = async (): Promise<McpOAuthRefreshResult> => ({
      ok: false,
      message: "invalid_grant: refresh token revoked",
    });

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(store.mcpClaims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });

  test("a failed refresh whose reconnect mail also fails leaves the credential unclaimed", async () => {
    const store = inMemoryStore([], [mcpCredential()]);
    const notify = throwingNotifyDeps(new Error("postgres blip"));
    const refreshMcpTokens = async (): Promise<McpOAuthRefreshResult> => ({
      ok: false,
      message: "invalid_grant: refresh token revoked",
    });

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(store.mcpClaims).toEqual([]);

    const retryNotify = notifyDeps();
    await tickCredentialExpirySweep({
      store,
      notify: retryNotify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(store.mcpClaims).toEqual(["cred_mcp_1"]);
    expect(retryNotify.mailed).toEqual([
      { tenantId: "tnt_1", principalId: "prn_1" },
    ]);
  });

  test("an api_key mcp credential is never a refresh candidate", async () => {
    const store = inMemoryStore(
      [],
      [
        mcpCredential({
          credentialId: "cred_api_key",
          type: "api_key",
          refreshSecret: undefined,
        }),
      ],
    );
    const notify = notifyDeps();
    let refreshCalled = false;
    const refreshMcpTokens = async (): Promise<McpOAuthRefreshResult> => {
      refreshCalled = true;
      return { ok: true, tokens: { access_token: "x", token_type: "bearer" } };
    };

    await tickCredentialExpirySweep({
      store,
      notify,
      hubUrl: HUB_URL,
      refreshMcpTokens,
      now: () => now,
    });

    expect(refreshCalled).toBe(false);
    expect(store.mcpRefreshes).toEqual([]);
    expect(store.mcpClaims).toEqual([]);
  });
});
