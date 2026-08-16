// Exercises `createMcpServerRoutes`' HTTP surface against a fake hub API
// (`apiCall`) and a stubbed probe, mirroring `routes.test.ts`'s own
// bare-Hono/tenant-injecting-middleware setup. Nothing here touches the
// real network or a real MCP server.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ApiCall } from "@workbench/hub-client";
import { createMcpServerRoutes } from "./mcp-server-routes";
import type { McpProbeResult } from "./mcp-probe";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_alice",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_alice",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

type ProviderRow = {
  id: string;
  tenantId: string;
  name: string;
  plugin: string;
  apiBaseUrl?: string;
  createdAt: string;
  updatedAt: string;
};
type CredentialRow = {
  id: string;
  tenantId: string;
  providerId: string;
  name: string;
  type: "api_key";
  secret: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
};

function fakeHub(seed: {
  providers?: ProviderRow[];
  credentials?: CredentialRow[];
}) {
  const providers = seed.providers ?? [];
  const credentials = seed.credentials ?? [];
  let nextId = 1;

  const apiCall: ApiCall = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/providers?inherited=false")) {
      return {
        status: 200,
        data: { data: providers, nextCursor: null },
        cookies: [],
      };
    }
    if (method === "GET" && path.endsWith("/credentials")) {
      return {
        status: 200,
        data: { data: credentials, nextCursor: null },
        cookies: [],
      };
    }
    if (method === "POST" && path.endsWith("/providers")) {
      const input = body as {
        name: string;
        plugin: string;
        apiBaseUrl?: string;
      };
      const row: ProviderRow = {
        id: `prv_${nextId++}`,
        tenantId: TENANT.id,
        name: input.name,
        plugin: input.plugin,
        ...(input.apiBaseUrl !== undefined
          ? { apiBaseUrl: input.apiBaseUrl }
          : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      providers.push(row);
      return { status: 201, data: row, cookies: [] };
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      const input = body as {
        providerId: string;
        name: string;
        type: "api_key";
        secret: string;
      };
      const row: CredentialRow = {
        id: `crd_${nextId++}`,
        tenantId: TENANT.id,
        providerId: input.providerId,
        name: input.name,
        type: input.type,
        secret: input.secret,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      credentials.push(row);
      return { status: 201, data: row, cookies: [] };
    }
    if (method === "DELETE" && path.includes("/credentials/")) {
      const id = path.split("/").pop();
      const idx = credentials.findIndex((c) => c.id === id);
      if (idx !== -1) credentials.splice(idx, 1);
      return { status: 204, data: undefined, cookies: [] };
    }
    throw new Error(`unhandled fake hub call: ${method} ${path}`);
  };

  return { apiCall, providers, credentials };
}

function mountAs(routes: Hono<TenantEnv>): Hono<TenantEnv> {
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

function buildApp(opts: {
  apiCall: ApiCall;
  probe?: (url: string, token: string | undefined) => Promise<McpProbeResult>;
  requireGrant?: RequireGrant;
}) {
  const routes = createMcpServerRoutes({
    hubUrl: "http://hub.test",
    requireGrant: opts.requireGrant ?? allowAll,
    log: () => {},
    apiCall: opts.apiCall,
    probe: opts.probe ?? (async () => ({ ok: true, toolCount: 3 })),
  });
  return mountAs(routes);
}

describe("POST /", () => {
  test("connects a new MCP server: probes, stores provider + credential, slugs the name", async () => {
    const hub = fakeHub({});
    const app = buildApp({ apiCall: hub.apiCall });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Notion Workspace",
        url: "https://mcp.notion.example/sse",
        token: "secret-token",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      slug: string;
      name: string;
      url: string;
      toolCount: number;
    };
    expect(body.slug).toBe("notion-workspace");
    expect(body.name).toBe("Notion Workspace");
    expect(body.toolCount).toBe(3);
    expect(hub.providers).toHaveLength(1);
    expect(hub.providers[0]?.name).toBe("mcp:notion-workspace");
    expect(hub.providers[0]?.apiBaseUrl).toBe("https://mcp.notion.example");
    expect(hub.credentials).toHaveLength(1);
    expect(hub.credentials[0]?.secret).toBe("secret-token");
  });

  test("de-duplicates a slug collision by appending a numeric suffix", async () => {
    const hub = fakeHub({
      providers: [
        {
          id: "prv_existing",
          tenantId: TENANT.id,
          name: "mcp:notion",
          plugin: "http",
          apiBaseUrl: "https://mcp.notion.example",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const app = buildApp({ apiCall: hub.apiCall });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Notion",
        url: "https://mcp.notion.example/sse",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { slug: string };
    expect(body.slug).toBe("notion-2");
  });

  test("a failing probe never touches storage", async () => {
    const hub = fakeHub({});
    const app = buildApp({
      apiCall: hub.apiCall,
      probe: async () => ({ ok: false, message: "could not connect" }),
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Broken",
        url: "https://broken.example/mcp",
      }),
    });

    expect(response.status).toBe(422);
    expect(hub.providers).toHaveLength(0);
  });
});

describe("GET / and DELETE /:slug", () => {
  test("lists connected servers and disconnects one", async () => {
    const hub = fakeHub({
      providers: [
        {
          id: "prv_1",
          tenantId: TENANT.id,
          name: "mcp:notion",
          plugin: "http",
          apiBaseUrl: "https://mcp.notion.example",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      credentials: [
        {
          id: "crd_1",
          tenantId: TENANT.id,
          providerId: "prv_1",
          name: "Notion",
          type: "api_key",
          secret: "tok",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const app = buildApp({ apiCall: hub.apiCall });

    const listed = await app.request("/");
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      data: { slug: string; name: string; url: string }[];
    };
    expect(listedBody.data).toEqual([
      { slug: "notion", name: "Notion", url: "https://mcp.notion.example" },
    ]);

    const deleted = await app.request("/notion", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(hub.credentials).toHaveLength(0);
  });

  test("disconnecting an unknown slug is a 404", async () => {
    const hub = fakeHub({});
    const app = buildApp({ apiCall: hub.apiCall });
    const response = await app.request("/nope", { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});
