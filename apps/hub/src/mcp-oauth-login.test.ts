// The MCP OAuth login route runs discovery, registration, the loopback wait
// and token storage behind one POST; the fakes below stand in for the network,
// the callback listener and the database so the whole loop is pinned.

import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";

import type { TenantEnv, TenantRow, PrincipalRow } from "@intx/hub-api";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import type { CallbackServer, FetchLike } from "@corbits/oauth-core";

import {
  MCP_OAUTH_CLIENT_ID_METADATA_KEY,
  MCP_OAUTH_TOKEN_URL_METADATA_KEY,
  mountMcpOAuthLogin,
} from "./mcp-oauth-login";

const RESOURCE_URL = "https://mcp.example.test/mcp";
const AS_ISSUER = "https://auth.example.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl: FetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.includes("oauth-protected-resource")) {
    return jsonResponse({
      resource: RESOURCE_URL,
      authorization_servers: [AS_ISSUER],
    });
  }
  if (url.includes("oauth-authorization-server")) {
    return jsonResponse({
      issuer: AS_ISSUER,
      authorization_endpoint: `${AS_ISSUER}/authorize`,
      token_endpoint: `${AS_ISSUER}/token`,
      registration_endpoint: `${AS_ISSUER}/register`,
    });
  }
  if (url === `${AS_ISSUER}/register` && method === "POST") {
    return jsonResponse({ client_id: "dyn-client-1" });
  }
  if (url === `${AS_ISSUER}/token` && method === "POST") {
    return jsonResponse({
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_in: 3600,
    });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as FetchLike;

const requireGrant: MiddlewareHandler<TenantEnv> = async (c, next) => {
  c.set("tenant", {
    id: "tnt_1",
    name: "Test",
    slug: "test",
    domain: "test",
    parentId: null,
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies TenantRow);
  c.set("principal", {
    id: "prn_1",
    tenantId: "tnt_1",
    kind: "user",
    refId: "user-1",
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies PrincipalRow);
  await next();
};

const cipher: CredentialCipher = {
  encrypt: (plaintext) => Promise.resolve(`enc:${plaintext}`),
  decrypt: (blob) => Promise.resolve(blob.replace(/^enc:/, "")),
};

type FakeDb = {
  db: DB["db"];
  inserted: unknown[];
  updated: unknown[];
};

function makeDb(existing: { id: string } | undefined): FakeDb {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const db = {
    query: {
      credential: {
        findFirst: () => Promise.resolve(existing),
      },
    },
    update: () => ({
      set: (row: unknown) => ({
        where: () => {
          updated.push(row);
          return Promise.resolve();
        },
      }),
    }),
    transaction: (fn: (tx: unknown) => Promise<void>) =>
      fn({
        insert: () => ({
          values: (value: unknown) => {
            inserted.push(value);
            return Promise.resolve();
          },
        }),
      }),
  };
  return { db: db as unknown as DB["db"], inserted, updated };
}

const callbackServer: CallbackServer = {
  close: () => undefined,
  waitForCode: () => Promise.resolve("auth-code-1"),
} as unknown as CallbackServer;

function mount(
  existing: { id: string } | undefined,
  overrides?: { readonly fetchImpl?: FetchLike },
): {
  app: Hono<TenantEnv>;
  inserted: unknown[];
  updated: unknown[];
} {
  const app = new Hono<TenantEnv>();
  const { db, inserted, updated } = makeDb(existing);
  mountMcpOAuthLogin(app, {
    db,
    cipher,
    requireGrant,
    fetchImpl: overrides?.fetchImpl ?? fetchImpl,
    startCallback: () =>
      Promise.resolve({ server: callbackServer, redirectUri: "http://127.0.0.1:9/callback" }),
  });
  return { app, inserted, updated };
}

const START_BODY = {
  providerId: "prv_linear",
  handle: "linear",
  name: "Linear",
  url: RESOURCE_URL,
  resourceUrl: RESOURCE_URL,
  credentialName: "mcp-linear",
};

async function waitForLogin(
  app: Hono<TenantEnv>,
  loginId: string,
): Promise<{ status: string; credentialId?: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await app.request(`/mcp/oauth-logins/${loginId}`);
    const state = (await res.json()) as { status: string; credentialId?: string };
    if (state.status !== "pending") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the login never settled");
}

describe("mountMcpOAuthLogin", () => {
  test("a first sign-in stores the tokens as an api_key credential", async () => {
    const { app, inserted, updated } = mount(undefined);

    const started = await app.request("/mcp/oauth-logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(START_BODY),
    });
    expect(started.status).toBe(201);
    const { loginId, authorizeUrl } = (await started.json()) as {
      loginId: string;
      authorizeUrl: string;
    };
    expect(authorizeUrl.startsWith(`${AS_ISSUER}/authorize`)).toBe(true);

    const settled = await waitForLogin(app, loginId);
    expect(settled.status).toBe("completed");
    expect(typeof settled.credentialId).toBe("string");

    // One credential row plus its creator grant, no in-place update.
    expect(updated.length).toBe(0);
    const credentialRow = inserted.find(
      (row) => (row as { name?: unknown }).name === "mcp-linear",
    ) as
      | {
          type: string;
          secret: string;
          refreshSecret: string | null;
          metadata: Record<string, unknown>;
        }
      | undefined;
    expect(credentialRow?.type).toBe("api_key");
    expect(credentialRow?.secret).toBe("enc:access-token-1");
    expect(credentialRow?.refreshSecret).toBe("enc:refresh-token-1");
    const mcp = credentialRow?.metadata["mcp"] as
      | { handle: string; url: string; auth: string }
      | undefined;
    expect(mcp).toMatchObject({ handle: "linear", url: RESOURCE_URL, auth: "oauth" });
    expect(credentialRow?.metadata[MCP_OAUTH_CLIENT_ID_METADATA_KEY]).toBe("dyn-client-1");
    expect(credentialRow?.metadata[MCP_OAUTH_TOKEN_URL_METADATA_KEY]).toBe(`${AS_ISSUER}/token`);
  });

  test("a re-sign-in replaces the tokens on the existing credential", async () => {
    const { app, inserted, updated } = mount({ id: "crd_old" });

    const started = await app.request("/mcp/oauth-logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(START_BODY),
    });
    expect(started.status).toBe(201);
    const { loginId } = (await started.json()) as { loginId: string };

    const settled = await waitForLogin(app, loginId);
    expect(settled).toMatchObject({ status: "completed", credentialId: "crd_old" });
    expect(inserted.length).toBe(0);
    expect(updated.length).toBe(1);
  });

  test("an undiscoverable server is rejected without a login", async () => {
    const { app } = mount(undefined);
    const started = await app.request("/mcp/oauth-logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...START_BODY, resourceUrl: "not-a-url" }),
    });
    expect(started.status).toBe(400);
  });

  test("a link-local resource URL is rejected before discovery", async () => {
    let fetches = 0;
    const counting = ((input: string | URL | Request, init?: RequestInit) => {
      fetches += 1;
      return fetchImpl(input, init);
    }) as FetchLike;
    const { app } = mount(undefined, { fetchImpl: counting });
    const started = await app.request("/mcp/oauth-logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...START_BODY,
        resourceUrl: "https://169.254.169.254/latest/meta-data/",
      }),
    });
    expect(started.status).toBe(400);
    expect(fetches).toBe(0);
  });

  test("plain-http and loopback resource URLs are rejected before discovery", async () => {
    for (const resourceUrl of [
      "http://mcp.example.test/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.8/mcp",
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://localhost/mcp",
    ]) {
      let fetches = 0;
      const counting = ((input: string | URL | Request, init?: RequestInit) => {
        fetches += 1;
        return fetchImpl(input, init);
      }) as FetchLike;
      const { app } = mount(undefined, { fetchImpl: counting });
      const started = await app.request("/mcp/oauth-logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...START_BODY, resourceUrl }),
      });
      expect(started.status).toBe(400);
      expect(fetches).toBe(0);
    }
  });
});
