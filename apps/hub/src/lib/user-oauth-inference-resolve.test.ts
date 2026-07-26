import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GrantStore } from "@intx/types/authz";
import type { HubDb } from "../db";

// ── Module-boundary mocks. The SUT is imported dynamically below so its
// module-eval `getLogger` call resolves against the mocked logger.

const warnings: { message: string; fields: Record<string, unknown> }[] = [];
mock.module("@intx/log", () => ({
  getLogger: () => ({
    warn: (message: string, fields: Record<string, unknown>) => {
      warnings.push({ message, fields });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

let enabledProviders: string[] = ["chatgpt-codex", "xai-grok"];
mock.module("../config", () => ({
  enabledUserOAuthInferenceProviders: () => enabledProviders,
}));

mock.module("./oauth-crypto", () => ({
  // The envelope is exercised by `credential-crypto.test.ts`; here it is a
  // transparent boundary so the test asserts resolution, not AES.
  decryptSecret: (v: string) => v.replace(/^enc:/, ""),
  encryptSecret: (v: string) => `enc:${v}`,
}));

let capabilityAllowed = true;
mock.module("./capability-grants", () => ({
  isCapabilityAllowedForPrincipal: async () => capabilityAllowed,
}));

let refreshImpl: () => Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> = async () => ({ access_token: "fresh-token", expires_in: 3600 });
let refreshCalls = 0;
// The resolver calls `oauthCredentialName` immediately before the credential
// lookup, so recording it here is exactly the name the real `where` clause
// filters on — the fake db below matches against it rather than guessing.
let lastRequestedName = "";
mock.module("./oauth-flow", () => ({
  oauthCredentialName: (provider: string, principalId: string) => {
    lastRequestedName = `oauth:${provider}:${principalId}`;
    return lastRequestedName;
  },
  resolveOAuthClientForProvider: async () => ({
    clientId: "client-1",
    clientSecret: "",
    redirectUri: "https://hub.test/oauth/callback/chatgpt-codex",
  }),
  refreshOAuthToken: async () => {
    refreshCalls += 1;
    return refreshImpl();
  },
}));

const { resolveUserOAuthInferenceSources } = await import(
  "./user-oauth-inference"
);

const TENANT = "ten-1";
const MEMBER = "prn-member";
const NOW = Date.UTC(2026, 6, 1);
const CODEX_CREDENTIAL_NAME = `oauth:chatgpt-codex:${MEMBER}`;

type CredentialRow = {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  type: string;
  secret: string;
  refreshSecret: string | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
};

function codexRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "cred-1",
    tenantId: TENANT,
    name: CODEX_CREDENTIAL_NAME,
    status: "active",
    type: "oauth_token",
    secret: "enc:stale-token",
    refreshSecret: "enc:refresh-token",
    expiresAt: new Date(NOW - 1_000),
    metadata: { chatgptAccountId: "acct-9" },
    ...overrides,
  };
}

const updatedRows: { id: string; values: Record<string, unknown> }[] = [];

/**
 * Fake HubDb backed by an explicit row list. `findFirst` matches on the exact
 * (tenantId, name, status) the resolver builds — the same triple the real
 * `where` clause uses — so a row stored under another principal's credential
 * name is genuinely unreachable rather than filtered by the fake.
 */
function makeDb(rows: CredentialRow[]): HubDb {
  return {
    query: {
      credential: {
        findFirst: async (args: { where: unknown }) => {
          void args;
          return (
            rows.find(
              (r) =>
                r.tenantId === TENANT &&
                r.name === lastRequestedName &&
                r.status === "active",
            ) ?? undefined
          );
        },
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updatedRows.push({ id: rows[0]?.id ?? "?", values });
        },
      }),
    }),
  } as unknown as HubDb;
}

function resolve(db: HubDb, opts: { grantStore?: GrantStore } = {}) {
  return resolveUserOAuthInferenceSources({
    db,
    tenantId: TENANT,
    memberPrincipalId: MEMBER,
    modelNames: ["gpt-5.6-sol"],
    redirectUriBase: "https://hub.test",
    now: () => NOW,
    ...opts,
  });
}

beforeEach(() => {
  warnings.length = 0;
  updatedRows.length = 0;
  refreshCalls = 0;
  capabilityAllowed = true;
  enabledProviders = ["chatgpt-codex", "xai-grok"];
  lastRequestedName = "";
  refreshImpl = async () => ({ access_token: "fresh-token", expires_in: 3600 });
});

describe("resolveUserOAuthInferenceSources", () => {
  test("an expired access token is refreshed and the fresh one is injected", async () => {
    const sources = await resolve(makeDb([codexRow()]));

    expect(refreshCalls).toBe(1);
    expect(sources.map((s) => s.apiKey)).toEqual(["fresh-token"]);
    expect(updatedRows[0]?.values["secret"]).toBe("enc:fresh-token");
  });

  test("a refresh failure is logged with the provider and credential, not swallowed", async () => {
    refreshImpl = async () => {
      throw new Error(
        "OAuth token refresh failed for chatgpt-codex: 400 invalid_grant",
      );
    };

    const sources = await resolve(makeDb([codexRow()]));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "User OAuth inference token refresh failed",
    );
    expect(warnings[0]?.fields["providerName"]).toBe("chatgpt-codex");
    expect(warnings[0]?.fields["credentialId"]).toBe("cred-1");
    expect(warnings[0]?.fields["memberPrincipalId"]).toBe(MEMBER);
    // The stale token still rides so a provider grace window keeps working,
    // but the failure is now traceable.
    expect(sources.map((s) => s.apiKey)).toEqual(["stale-token"]);
    expect(updatedRows).toHaveLength(0);
  });

  test("a denied capability grant suppresses injection entirely", async () => {
    capabilityAllowed = false;
    const grantStore = {} as GrantStore;

    const sources = await resolve(makeDb([codexRow()]), { grantStore });

    expect(sources).toEqual([]);
    expect(refreshCalls).toBe(0);
  });

  test("a credential belonging to a different principal is not resolved", async () => {
    const otherPrincipalRow = codexRow({
      id: "cred-other",
      name: "oauth:chatgpt-codex:prn-someone-else",
    });

    const sources = await resolve(makeDb([otherPrincipalRow]));

    expect(sources).toEqual([]);
  });

  test("a provider absent from the deployment allowlist injects nothing", async () => {
    enabledProviders = ["xai-grok"];

    const sources = await resolve(makeDb([codexRow()]));

    expect(sources).toEqual([]);
    expect(refreshCalls).toBe(0);
  });

  test("an unexpired token is used as-is without a refresh call", async () => {
    const sources = await resolve(
      makeDb([codexRow({ expiresAt: new Date(NOW + 60 * 60 * 1000) })]),
    );

    expect(refreshCalls).toBe(0);
    expect(sources.map((s) => s.apiKey)).toEqual(["stale-token"]);
  });

  test("the Codex account id rides in providerOptions for the header lift", async () => {
    const sources = await resolve(
      makeDb([codexRow({ expiresAt: new Date(NOW + 60 * 60 * 1000) })]),
    );

    expect(sources[0]?.defaults?.providerOptions).toEqual({
      codexAccountId: "acct-9",
    });
  });
});
