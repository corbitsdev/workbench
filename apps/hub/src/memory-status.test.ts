import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { MemoryConfig } from "@corbits/memory";

import {
  buildMemoryPlaneStatus,
  createMemoryStatusRoutes,
  hostOnly,
  MEMORY_SETUP_OPTIONS,
  type MemoryPlaneStatus,
} from "./memory-status";

const baseConfig: MemoryConfig = {
  memory: {
    databaseUrl: "postgres://localhost:5432/workbench",
    dbPoolMax: 8,
    ftsLanguage: "english",
    rerank: {
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
      timeoutMs: undefined,
    },
  },
};

const degrade = {
  tenantId: "tnt_1",
  totalSearches: 12,
  degradeCounts: {
    dense_unavailable: 0,
    rerank_unavailable: 0,
    rerank_query_too_long: 0,
    live_timeout: 0,
    live_error: 0,
    memory_unavailable: 0,
    lexical_only: 0,
  },
  since: new Date("2026-08-01T00:00:00.000Z"),
  windowSize: 12,
  windowedDegradeRate: {
    dense_unavailable: 0,
    rerank_unavailable: 0,
    rerank_query_too_long: 0,
    live_timeout: 0,
    live_error: 0,
    memory_unavailable: 0,
    lexical_only: 0,
  },
  escalated: {
    dense_unavailable: false,
    rerank_unavailable: false,
    rerank_query_too_long: false,
    live_timeout: false,
    live_error: false,
    memory_unavailable: false,
    lexical_only: false,
  },
};

describe("hostOnly", () => {
  test("extracts just the host, dropping path/query — never a full URL that could carry a credential", () => {
    expect(hostOnly("https://api.openai.com/v1?key=secret")).toBe(
      "api.openai.com",
    );
  });

  test("falls back to the raw string for something that isn't a real URL", () => {
    expect(hostOnly("not-a-url")).toBe("not-a-url");
  });
});

describe("MEMORY_SETUP_OPTIONS", () => {
  test("includes lexical-only as a real, honest option — not framed as needing no setup at all", () => {
    const lexicalOnly = MEMORY_SETUP_OPTIONS.find(
      (option) => option.kind === "lexical-only",
    );
    expect(lexicalOnly).toBeDefined();
    expect(lexicalOnly?.kind === "lexical-only" && lexicalOnly.caveat).toMatch(
      /pgvector/,
    );
  });
});

describe("buildMemoryPlaneStatus", () => {
  test("reports embeddingsConfigured from Memory.capabilities, not from config presence", () => {
    const status = buildMemoryPlaneStatus(
      "lexical-only",
      baseConfig,
      { embeddingsConfigured: false },
      degrade,
    );
    expect(status.embeddingsConfigured).toBe(false);
    expect(status.embed).toBeNull();
    expect(status.missing).toHaveLength(1);
    expect(status.setupOptions).toEqual(MEMORY_SETUP_OPTIONS);
  });

  test("reports a dense embed host/model and no missing setup when embeddings are configured", () => {
    const config: MemoryConfig = {
      memory: {
        ...baseConfig.memory,
        embed: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          apiStyle: "openai",
          apiKey: "sk-test",
          timeoutMs: undefined,
        },
      },
    };
    const status = buildMemoryPlaneStatus(
      "env",
      config,
      { embeddingsConfigured: true },
      degrade,
    );
    expect(status.embed).toEqual({
      model: "text-embedding-3-small",
      host: "api.openai.com",
    });
    expect(status.missing).toEqual([]);
    expect(status.setupOptions).toEqual([]);
  });

  test("never leaks the rerank API key or full URL, only host + model", () => {
    const config: MemoryConfig = {
      memory: {
        ...baseConfig.memory,
        rerank: {
          baseUrl: "https://rerank.example.com/v1?token=shh",
          model: "rerank-v1",
          apiKey: "shh-rerank-key",
          maxDocChars: undefined,
          timeoutMs: undefined,
        },
      },
    };
    const status = buildMemoryPlaneStatus(
      "lexical-only",
      config,
      { embeddingsConfigured: false },
      degrade,
    );
    expect(status.rerank).toEqual({
      configured: true,
      model: "rerank-v1",
      host: "rerank.example.com",
    });
    expect(JSON.stringify(status)).not.toContain("shh");
  });
});

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

const READY_STATUS: MemoryPlaneStatus = {
  source: "lexical-only",
  embeddingsConfigured: false,
  embed: null,
  rerank: { configured: false },
  degrade: {
    totalSearches: 0,
    since: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    windowSize: 0,
    windowedDegradeRate: {},
    escalated: {},
  },
  missing: ["a dense embedding endpoint"],
  setupOptions: MEMORY_SETUP_OPTIONS,
};

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

describe("createMemoryStatusRoutes' grant guard", () => {
  test("gates on the workbench-owned memory:status action — never memory:read, and never one of @corbits/memory's own add/search/forget/purge actions", async () => {
    const seen: { resource: string; action: string }[] = [];
    const recordingRequireGrant: RequireGrant = (resource, action) => {
      seen.push({ resource: resource as string, action });
      return async (_c, next) => {
        await next();
      };
    };

    const app = mountAs(
      createMemoryStatusRoutes({
        plane: { describeStatus: async () => READY_STATUS },
        requireGrant: recordingRequireGrant,
        describeCaller: async () => ({ kind: "scoped" }),
      }),
    );

    const response = await app.request("/status");

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ resource: "memory", action: "status" }]);
  });

  test("answers with the plane's facts and this caller's own scope, so the page never has to guess which one a failure was about", async () => {
    const app = mountAs(
      createMemoryStatusRoutes({
        plane: { describeStatus: async () => READY_STATUS },
        requireGrant: () => async (_c, next) => {
          await next();
        },
        describeCaller: async () => ({ kind: "scoped" }),
      }),
    );

    const response = await app.request("/status");

    expect(await response.json()).toEqual({
      plane: READY_STATUS,
      caller: { kind: "scoped" },
    });
  });

  // A guest holds no principal in the org tenant memory lives in, so a
  // search would refuse them. That is a fact about who is asking, not a
  // fault, so it rides back on a 200 the page can explain — never the bare
  // 403 that reads to a person as the deploy being broken.
  test("reports a caller who holds no memory here by name, on a 200 rather than an error", async () => {
    const app = mountAs(
      createMemoryStatusRoutes({
        plane: { describeStatus: async () => READY_STATUS },
        requireGrant: () => async (_c, next) => {
          await next();
        },
        describeCaller: async () => ({
          kind: "unscoped",
          reason: "no-org-principal",
        }),
      }),
    );

    const response = await app.request("/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plane: READY_STATUS,
      caller: { kind: "unscoped", reason: "no-org-principal" },
    });
  });

  // Nothing plants a grant on the `memory` resource. Every tenant owner
  // reaches this route through the wildcard grant the platform gives the owner
  // role at tenant creation, which is why no seeded grant is needed and why an
  // already-provisioned tenant is not locked out. If Interchange ever narrows
  // wildcard matching, this fails here rather than as a settings section that
  // quietly stops appearing.
  test("a tenant owner's wildcard role grant covers the status action", async () => {
    const ownerRoleGrant: GrantRule = {
      id: "grant_owner_wildcard",
      resource: "*",
      action: "*",
      effect: "allow",
      origin: "system",
      conditions: null,
      expiresAt: null,
      roleId: "role_owner",
      principalId: null,
    };

    const result = await evaluateGrants([ownerRoleGrant], "memory", "status");

    expect(result.effect).toBe("allow");
  });

  test("403s a principal who was never granted memory:status", async () => {
    const denyingRequireGrant: RequireGrant = () => async (c) =>
      c.json({ error: { code: "forbidden", message: "not granted" } }, 403);

    const app = mountAs(
      createMemoryStatusRoutes({
        plane: { describeStatus: async () => READY_STATUS },
        requireGrant: denyingRequireGrant,
        describeCaller: async () => ({ kind: "scoped" }),
      }),
    );

    const response = await app.request("/status");

    expect(response.status).toBe(403);
  });
});
