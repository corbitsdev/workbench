// Exercises `createTemplateBlockRoutes`' HTTP surface through the real
// `buildBlockWorkflowSource` builder, mounted the same way
// `./connect-github-routes.test.ts` mounts its routes: a bare `Hono`
// with a tenant-injecting middleware, every port a plain fake.
//
// WIRING PINS (CL-8113): the per-workflow `buildJson` closures live on
// the hub's native `./catalog-blocks` `CATALOG_BLOCKS` entries and
// `buildBlockWorkflowSource` wires them through
// `deployableCatalogBlock`, so every catalog workflow deploys below
// with its real rendered definition — no silent no-op, no fake deploy.
// These tests pin that wiring in the open: the trigger address stamped
// into each deployed definition proves the real builder ran against the
// requesting tenant's domain. Dropped: nothing — the already-deployed
// 200 (the port reports `created: false`) and the failing-deploy 500
// (the route's catch branch) both run again.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@corbits/error-sink";

import {
  createTemplateBlockRoutes,
  type TemplateBlockRoutesDeps,
} from "./template-block-routes";

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

type DeployedSource = Parameters<
  TemplateBlockRoutesDeps["deployWorkflowSource"]
>[0];

function buildApp(overrides: Partial<TemplateBlockRoutesDeps> = {}) {
  const deployed: DeployedSource[] = [];
  const deps: TemplateBlockRoutesDeps = {
    requireGrant: allowAll,
    log: () => {},
    inferencePreferences: async () => [
      { provider: "anthropic", model: "claude-sonnet-5" },
    ],
    deployWorkflowSource: async (args) => {
      deployed.push(args);
      return { id: "wfd_code_review", created: true };
    },
    ...overrides,
  };
  return { app: mountAs(createTemplateBlockRoutes(deps)), deployed };
}

describe("POST /:assetName/deploy", () => {
  test("every catalog workflow deploys its real rendered definition", async () => {
    const { app, deployed } = buildApp();
    for (const assetName of [
      "code-review",
      "exa-topic-watch",
      "last-30-days-research",
      "granola-call",
    ]) {
      const res = await app.request(`/${assetName}/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; created: boolean };
      expect(body.created).toBe(true);
      expect(typeof body.id).toBe("string");
    }
    expect(deployed).toHaveLength(4);
    for (const args of deployed) {
      // A real rendered definition for THIS workflow: it parses, it
      // has steps to launch, and it names its own asset. (Not every
      // entry is mail-triggered, so the name — not a trigger address
      // — is the per-workflow pin.)
      expect(args.tenantId).toBe(TENANT.id);
      expect(args.principalId).toBe(PRINCIPAL.id);
      const parsed = JSON.parse(args.workflowJson) as {
        stepOrder?: readonly string[];
      };
      expect(parsed.stepOrder?.length).toBeGreaterThan(0);
      expect(args.workflowJson).toContain(args.assetName);
    }
    // code-review is mail-triggered: its builder stamps the requesting
    // tenant's trigger address in, proving the tenant's domain reaches
    // the real catalog builder (first deploy in the loop above).
    expect(deployed[0]?.workflowJson).toContain("code-review@acme.example");
  });

  test("an already-deployed definition answers 200 without redeploying", async () => {
    const { app, deployed } = buildApp({
      deployWorkflowSource: async (args) => {
        deployed.push(args);
        return { id: "wfd_code_review", created: false };
      },
    });
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; created: boolean };
    expect(body).toEqual({ id: "wfd_code_review", created: false });
    expect(deployed).toHaveLength(1);
  });

  test("a failing deploy answers a 500 envelope, deploying nothing more", async () => {
    const { app, deployed } = buildApp({
      deployWorkflowSource: async () => {
        throw new Error("asset store is down");
      },
    });
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(body.error.code).toBe("deploy_failed");
    expect(deployed).toHaveLength(0);
  });

  test("an asset name no block builder covers answers 404, deploying nothing", async () => {
    const { app, deployed } = buildApp();
    const res = await app.request("/does-not-exist/deploy", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(deployed).toHaveLength(0);
  });

  test("a denied grant answers a 403 envelope with a refId, deploying nothing", async () => {
    const { app, deployed } = buildApp({
      requireGrant: () => async (c) => {
        return c.json(
          makeErrorEnvelope({
            code: "forbidden",
            userMessage: "You do not have permission to perform this action",
          }),
          403,
        );
      },
    });
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("forbidden");
    expect(typeof body.error.refId).toBe("string");
    expect(body.error.refId.length).toBeGreaterThan(0);
    expect(deployed).toHaveLength(0);
  });

  test("assistant is seeded, never deployed through this route", async () => {
    const { app, deployed } = buildApp();
    const res = await app.request("/assistant/deploy", { method: "POST" });
    expect(res.status).toBe(404);
    expect(deployed).toHaveLength(0);
  });

  test("heartbeat is test-only, never deployed through this route", async () => {
    const { app, deployed } = buildApp();
    const res = await app.request("/heartbeat/deploy", { method: "POST" });
    expect(res.status).toBe(404);
    expect(deployed).toHaveLength(0);
  });
});
