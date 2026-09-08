// CL-7508: the loopback connect route returns the authorize URL the
// sidecar's login staged, resolves the typed gate outcome when no local
// sidecar passed the gate, and persists the terminal tokens through the
// shared connect pipeline (including the id_token-derived metadata).
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import type { ConnectorDescriptor } from "./descriptor";
import {
  createOAuthLoopbackRoutes,
  type CreateOAuthLoopbackRoutesDeps,
} from "./oauth-loopback-routes";

const loopbackDescriptor: ConnectorDescriptor = {
  id: "codex",
  displayName: "Codex",
  authKind: "oauth-loopback",
  docsUrl: "https://example.com/docs",
  feedsTools: [],
  credentialPlugin: "http",
  oauth: {
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    usesPKCE: true,
    echoesState: true,
    deploysDefaultWorkflows: true,
    buildAuthorizeUrl: ({ state }) =>
      new URL(`https://auth.openai.com/oauth/authorize?state=${state}`),
    exchange: async () => ({ ok: false, message: "unused in this test" }),
  },
};

function makeDeps(overrides?: {
  requestOAuthLogin?: CreateOAuthLoopbackRoutesDeps["requestOAuthLogin"];
  persistConnectorCredentialFn?: CreateOAuthLoopbackRoutesDeps["seedCatalogFn"];
}) {
  const persisted: {
    tenantId: string;
    connectorId: string;
    secret: string;
    expiresAt: string | undefined;
    metadata: Record<string, unknown> | undefined;
    refreshSecret: string | undefined;
  }[] = [];
  const deps: CreateOAuthLoopbackRoutesDeps = {
    hubUrl: "http://hub.test",
    log: () => undefined,
    registry: { codex: loopbackDescriptor },
    requestOAuthLogin:
      overrides?.requestOAuthLogin ??
      (() =>
        Promise.resolve({
          status: "gate",
          message: "requires a local sidecar",
        })),
    ensureProviderFn: async () => "prov_1",
    ensureCredentialFn: async (_api, _cookies, args) => {
      persisted.push({
        tenantId: args.tenantId,
        connectorId: args.name,
        secret: args.secret,
        expiresAt: args.expiresAt,
        metadata: args.metadata,
        refreshSecret: args.refreshSecret,
      });
      return "cred_1";
    },
    seedCatalogFn: async () => ({
      completionCapable: false,
      modelsSeeded: 0,
      hasCompletionCapableModel: false,
    }),
  };
  return { deps, persisted };
}

function tenantEnvApp(deps: CreateOAuthLoopbackRoutesDeps) {
  // Mirror the hub's tenant middleware: the factory reads
  // `c.get("tenant")`/`c.get("principal")` from the resolved env.
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  });
  app.route("/", createOAuthLoopbackRoutes(deps));
  return app;
}

function makeRequest(): Request {
  return new Request("http://hub.test/codex/loopback", {
    method: "POST",
    headers: { cookie: "session=cookie-value" },
  });
}

// Minimal TenantEnv stand-ins: the route factory only reads
// `c.get("tenant")`/`c.get("principal")` from the typed env, and the
// wrapper middleware supplies them.
const TENANT = {
  id: "tenant_1",
  name: "Bench",
  slug: "bench",
  domain: "bench.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const PRINCIPAL = {
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("createOAuthLoopbackRoutes", () => {
  test("no local sidecar resolves the typed gate outcome", async () => {
    const { deps } = makeDeps();
    const response = await tenantEnvApp(deps).request(makeRequest());
    expect(response.status).toBe(409);
    const body = (await response.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("gate");
  });

  test("a started login returns its authorize URL and persists the terminal tokens", async () => {
    let resolveCompleted: (final: {
      status: "completed";
      tokens: {
        access: string;
        refresh: string;
        expiresAt: number;
        accountId: string;
      };
    }) => void = () => undefined;
    const completed = new Promise<{
      status: "completed" | "error";
      tokens?: {
        access: string;
        refresh: string;
        expiresAt: number;
        accountId: string;
      };
      message?: string;
    }>((resolve) => {
      resolveCompleted = resolve as typeof resolveCompleted;
    });
    const { deps, persisted } = makeDeps({
      requestOAuthLogin: () =>
        Promise.resolve({
          status: "started",
          requestId: "req_1",
          authorizeUrl: "https://auth.openai.com/oauth/authorize?x=1",
          completed: completed as never,
        }),
    });
    const app = tenantEnvApp(deps);
    const response = await app.request(makeRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      authorizeUrl: string;
    };
    expect(body.ok).toBe(true);
    expect(body.authorizeUrl).toContain("auth.openai.com");

    resolveCompleted({
      status: "completed",
      tokens: {
        access: "at",
        refresh: "rt",
        expiresAt: 1750000000000,
        accountId: "acc_42",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.secret).toBe("at");
    expect(persisted[0]?.refreshSecret).toBe("rt");
    // The expiry is a first-class credential COLUMN (serving-time refresh
    // keys on it), not free-form metadata.
    expect(persisted[0]?.expiresAt).toBe(new Date(1750000000000).toISOString());
    // The derived account label persists; the raw id_token never does.
    expect(persisted[0]?.metadata).toEqual({ accountId: "acc_42" });
  });

  test("a non-loopback connector is refused", async () => {
    const { deps } = makeDeps();
    const response = await tenantEnvApp(deps).request(
      new Request("http://hub.test/github/loopback", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });
});
