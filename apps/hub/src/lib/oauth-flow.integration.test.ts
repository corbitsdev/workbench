import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { resolveCredentialRequirement, schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { OAuthProviderConfig } from "@workbench/shared";

import { schema } from "../db";
import type { HubDb } from "../db";
import { decryptSecret, isEncryptedEnvelope } from "./oauth-crypto";
import {
  beginConnect,
  completeConnect,
  createInMemoryPendingStore,
  insertOAuthCredential,
  OAuthStateError,
  resolveOAuthToken,
  resolveOwnerOAuthClient,
} from "./oauth-flow";
import type { FetchLike } from "./oauth-flow";

// End-to-end exercise of the provider-agnostic OAuth engine against a FAKE
// provider (CL-3356 #2). Real PGlite + real Interchange credential resolution;
// only the provider's HTTP token endpoint is faked, at the fetch boundary — the
// state/PKCE/exchange/encrypted-credential-write seam under test is real.

const FAKE: OAuthProviderConfig = {
  providerName: "faketest",
  label: "Fake Test",
  authorizationUrl: "https://fake.test/authorize",
  tokenUrl: "https://fake.test/token",
  scopes: ["read", "write"],
  scopeDescriptions: { read: "Read things", write: "Write things" },
  usePkce: true,
  hasRefresh: true,
  appCredentialProviderName: "faketest-oauth-app",
  setup: {
    registerUrl: "https://fake.test/docs/oauth",
    callbackPath: "/oauth/callback/faketest",
    steps: ["Create an app", "Set the redirect URL", "Copy the credentials"],
    fieldHints: {
      clientId: "client id hint",
      clientSecret: "client secret hint",
    },
  },
};

const CLIENT_CONFIG = {
  clientId: "fake-client-id",
  clientSecret: "fake-client-secret",
  redirectUri: "https://hub.test/oauth/callback/faketest",
};
const STATE_SECRET = "test-state-secret";
const TENANT = "ten-oauth";
const MEMBER_A = "prn-member-a";
const MEMBER_B = "prn-member-b";
const ENC_KEY = randomBytes(32).toString("base64");

let client: PGlite;
let db: HubDb;
let tokenCalls: { url: string; body: string }[];

function makeFakeFetch(token: Record<string, unknown>): FetchLike {
  return (async (url, init) => {
    tokenCalls.push({
      url: String(url),
      body: String((init as RequestInit | undefined)?.body ?? ""),
    });
    return new Response(JSON.stringify(token), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
}

async function drive(memberPrincipalId: string) {
  const store = createInMemoryPendingStore();
  const { redirectUrl } = beginConnect({
    providerConfig: FAKE,
    clientConfig: CLIENT_CONFIG,
    tenantId: TENANT,
    memberPrincipalId,
    stateSecret: STATE_SECRET,
    pendingStore: store,
  });
  const state = new URL(redirectUrl).searchParams.get("state") ?? "";
  return { redirectUrl, state, store };
}

beforeAll(async () => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = ENC_KEY;
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
  await client?.close();
});

beforeEach(async () => {
  tokenCalls = [];
  await client.exec(`DELETE FROM credential;`);
  await client.exec(`DELETE FROM oauth_client;`);
  await client.exec(`DELETE FROM provider;`);
});

describe("authorize URL (PKCE + signed state)", () => {
  test("carries client_id, redirect, scope, and an S256 PKCE challenge", async () => {
    const { redirectUrl } = await drive(MEMBER_A);
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe("https://fake.test/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      CLIENT_CONFIG.redirectUri,
    );
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("callback → encrypted principal-owned credential", () => {
  test("exchanges the code (with verifier) and writes an encrypted credential", async () => {
    const fetchImpl = makeFakeFetch({
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
      expires_in: 3600,
      scope: "read write",
    });
    const { state, store } = await drive(MEMBER_A);

    const result = await completeConnect({
      db,
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      code: "auth-code-xyz",
      state,
      stateSecret: STATE_SECRET,
      pendingStore: store,
      fetchImpl,
    });

    // The exchange forwarded the code + PKCE verifier to the token endpoint.
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe("https://fake.test/token");
    expect(tokenCalls[0]!.body).toContain("code=auth-code-xyz");
    expect(tokenCalls[0]!.body).toContain("code_verifier=");
    expect(result.memberPrincipalId).toBe(MEMBER_A);

    const row = await db.query.credential.findFirst({});
    expect(row?.principalId).toBe(MEMBER_A);
    expect(row?.type).toBe("oauth_token");
    expect(row?.scopes).toEqual(["read", "write"]);
    // The token is envelope-encrypted at rest, never plaintext.
    expect(isEncryptedEnvelope(row!.secret)).toBe(true);
    expect(row!.secret).not.toContain("fake-access-token");
    expect(decryptSecret(row!.secret)).toBe("fake-access-token");
    expect(decryptSecret(row!.refreshSecret!)).toBe("fake-refresh-token");
  });

  test("the written credential resolves for its owner but not another member (per-user scoping)", async () => {
    const fetchImpl = makeFakeFetch({
      access_token: "member-a-token",
      scope: "read write",
    });
    const { state, store } = await drive(MEMBER_A);
    await completeConnect({
      db,
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      code: "code-a",
      state,
      stateSecret: STATE_SECRET,
      pendingStore: store,
      fetchImpl,
    });

    const forOwner = await resolveCredentialRequirement(
      db,
      TENANT,
      { providerName: FAKE.providerName, source: "invoker" },
      null,
      MEMBER_A,
    );
    const forOther = await resolveCredentialRequirement(
      db,
      TENANT,
      { providerName: FAKE.providerName, source: "invoker" },
      null,
      MEMBER_B,
    );
    expect(forOwner?.principalId).toBe(MEMBER_A);
    expect(forOther).toBeNull();
  });

  test("a tampered state is rejected before any exchange", async () => {
    const fetchImpl = makeFakeFetch({ access_token: "x" });
    const { state, store } = await drive(MEMBER_A);
    const tampered = state.slice(0, -2) + (state.endsWith("A") ? "B" : "A");
    await expect(
      completeConnect({
        db,
        providerConfig: FAKE,
        clientConfig: CLIENT_CONFIG,
        code: "code",
        state: tampered,
        stateSecret: STATE_SECRET,
        pendingStore: store,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthStateError);
    expect(tokenCalls).toHaveLength(0);
  });

  test("the PKCE verifier is single-use: replaying the callback fails", async () => {
    const fetchImpl = makeFakeFetch({ access_token: "x", scope: "read write" });
    const { state, store } = await drive(MEMBER_A);
    const args = {
      db,
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      code: "code",
      state,
      stateSecret: STATE_SECRET,
      pendingStore: store,
      fetchImpl,
    };
    await completeConnect(args);
    await expect(completeConnect(args)).rejects.toBeInstanceOf(OAuthStateError);
  });
});

describe("insertOAuthCredential concurrency (atomic upsert)", () => {
  function insertArgs(accessToken: string) {
    return {
      db,
      tenantId: TENANT,
      memberPrincipalId: MEMBER_A,
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      token: { access_token: accessToken, scope: "read write" },
    };
  }

  test("a second write for the same (provider, member) updates instead of throwing", async () => {
    await insertOAuthCredential(insertArgs("token-v1"));
    await insertOAuthCredential(insertArgs("token-v2"));

    const rows = await db.query.credential.findMany({});
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.secret)).toBe("token-v2");
  });

  test("concurrent completions do not raise a unique violation", async () => {
    const results = await Promise.all([
      insertOAuthCredential(insertArgs("concurrent-a")),
      insertOAuthCredential(insertArgs("concurrent-b")),
    ]);
    // Both resolve to the same single row.
    expect(results[0]!.credentialId).toBe(results[1]!.credentialId);
    const rows = await db.query.credential.findMany({});
    expect(rows).toHaveLength(1);
  });
});

describe("resolveOAuthToken (decrypt-at-read)", () => {
  test("returns the decrypted token for the owner and null for another member", async () => {
    await insertOAuthCredential({
      db,
      tenantId: TENANT,
      memberPrincipalId: MEMBER_A,
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      token: {
        access_token: "usable-access",
        refresh_token: "usable-refresh",
        scope: "read write",
      },
    });

    const owner = await resolveOAuthToken(
      db,
      TENANT,
      MEMBER_A,
      FAKE.providerName,
    );
    expect(owner?.accessToken).toBe("usable-access");
    expect(owner?.refreshToken).toBe("usable-refresh");
    expect(owner?.scopes).toEqual(["read", "write"]);

    const other = await resolveOAuthToken(
      db,
      TENANT,
      MEMBER_B,
      FAKE.providerName,
    );
    expect(other).toBeNull();
  });
});

describe("state freshness (replay protection independent of PKCE)", () => {
  test("a state older than the max age is rejected before any exchange", async () => {
    const t0 = 1_000_000;
    const store = createInMemoryPendingStore();
    const { redirectUrl } = beginConnect({
      providerConfig: FAKE,
      clientConfig: CLIENT_CONFIG,
      tenantId: TENANT,
      memberPrincipalId: MEMBER_A,
      stateSecret: STATE_SECRET,
      pendingStore: store,
      now: () => t0,
    });
    const state = new URL(redirectUrl).searchParams.get("state") ?? "";
    const fetchImpl = makeFakeFetch({ access_token: "x" });

    await expect(
      completeConnect({
        db,
        providerConfig: FAKE,
        clientConfig: CLIENT_CONFIG,
        code: "code",
        state,
        stateSecret: STATE_SECRET,
        pendingStore: store,
        fetchImpl,
        stateMaxAgeMs: 60_000,
        now: () => t0 + 61_000,
      }),
    ).rejects.toBeInstanceOf(OAuthStateError);
    expect(tokenCalls).toHaveLength(0);
  });
});

describe("owner-set OAuth app client (never env, never stubbed)", () => {
  test("resolveOwnerOAuthClient returns null when the owner has not registered the app", async () => {
    const resolved = await resolveOwnerOAuthClient(
      db,
      TENANT,
      FAKE,
      "https://hub.test/oauth/callback/faketest",
    );
    expect(resolved).toBeNull();
  });

  test("resolves the owner-set client id + secret once registered", async () => {
    // The owner sets the app on the Capabilities page: client secret →
    // credential.secret, client id → provider.metadata.baseURL.
    const providerId = generateId("provider");
    await db.insert(intxSchema.provider).values({
      id: providerId,
      tenantId: TENANT,
      name: FAKE.appCredentialProviderName,
      plugin: "faketest",
      metadata: { baseURL: "owner-client-id" },
    });
    await db.insert(intxSchema.credential).values({
      id: generateId("credential"),
      tenantId: TENANT,
      providerId,
      name: "Fake OAuth app",
      type: "api_key",
      secret: "owner-client-secret",
      status: "active",
    });

    const resolved = await resolveOwnerOAuthClient(
      db,
      TENANT,
      FAKE,
      "https://hub.test/oauth/callback/faketest",
    );
    expect(resolved).toEqual({
      clientId: "owner-client-id",
      clientSecret: "owner-client-secret",
      redirectUri: "https://hub.test/oauth/callback/faketest",
    });
  });
});
