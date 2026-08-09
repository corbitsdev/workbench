// Route-level tests cover this package's own wiring: request parsing,
// grant gating, and error-envelope mapping. The definition-projection
// path (`ensureWorkflowDefinitionForAsset` + the read-back query) is
// `@intx/hub-sessions`/`@intx/db` machinery already covered upstream —
// re-proving it here against a hand-rolled fake drizzle db would be
// coverage theater, not a meaningful test of this package's code.

import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import { AssetServiceError } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import { createAgentDefinitionRoutes } from "../src/routes";

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
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: () => {
      throw new Error("createAsset not stubbed for this test");
    },
    populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    listAssetBlobs: () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  };
}

// The duplicate-asset recovery path queries `db` directly (looking up the
// existing asset and its definition) before deciding whether to reuse an
// empty shell or surface a real 409. When the shell is reused the route
// continues through populateAsset → ensureWorkflowDefinitionForAsset →
// read-back, so the fake also provides just enough of drizzle's chainable
// query-builder API (`.select().from().where().limit()`,
// `.insert().values().onConflictDoNothing().returning()`) for that
// projection — the projection logic itself is `@intx/hub-sessions`/
// `@intx/db` machinery already covered upstream; the fake only needs to
// return plausible rows, not re-prove the SQL.

type FakeDbOptions = {
  existingAsset?: { id: string };
  hasDefinition?: boolean;
};

function fakeDb(opts: FakeDbOptions = {}): DB["db"] {
  let wfDefFindFirstCalls = 0;

  const selectResult = [
    {
      tenantId: TENANT.id,
      creatorPrincipalId: null,
      name: "research-buddy",
      displayName: "Research Buddy",
    },
  ];

  return {
    query: {
      asset: {
        findFirst: async () => opts.existingAsset ?? undefined,
      },
      workflowDefinition: {
        findFirst: async () => {
          wfDefFindFirstCalls += 1;
          if (wfDefFindFirstCalls === 1) {
            return opts.hasDefinition ? { id: "def_existing" } : undefined;
          }
          // Read-back after ensureWorkflowDefinitionForAsset.
          return {
            id: "def_new",
            tenantId: TENANT.id,
            name: "Research Buddy",
            description: null,
            currentVersion: "1",
            status: "deployed",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResult),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: "def_new" }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

function buildApp(
  assetService: AssetService,
  db: DB["db"] = fakeDb(),
): Hono<TenantEnv> {
  const routes = createAgentDefinitionRoutes({
    db,
    assetService,
    requireGrant: () => async (_c, next) => {
      await next();
    },
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

async function post(app: Hono<TenantEnv>, body: unknown): Promise<Response> {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a malformed body is rejected with a field-scoped 400", async () => {
  const app = buildApp(fakeAssetService());
  const response = await post(app, {
    name: "",
    handle: "Not Kebab",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { message: string } };
  expect(body.error.message).toContain("invalid agent definition");
});

test("a missing system prompt is rejected before any asset is created", async () => {
  let createCalled = false;
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        createCalled = true;
        throw new Error("should never be called");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
  });
  expect(response.status).toBe(400);
  expect(createCalled).toBe(false);
});

test("a duplicate handle surfaces as a 409, not a 500", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new AssetServiceError(
          "duplicate_asset",
          'an asset named "research-buddy" already exists',
        );
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("conflict");
});

test("an unrelated asset-service failure is not swallowed as a conflict", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new Error("the git backend is unreachable");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  // Hono's default error handler turns an uncaught throw into a 500
  // rather than the 409 the duplicate-asset path returns — proving this
  // route re-throws instead of misclassifying every asset-service
  // failure as a handle conflict.
  expect(response.status).toBe(500);
});
