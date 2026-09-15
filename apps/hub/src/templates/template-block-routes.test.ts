// Exercises `createTemplateBlockRoutes`' HTTP surface through the real
// `buildBlockWorkflowSource` builder, mounted the same way
// `./connect-github-routes.test.ts` mounts its routes: a bare `Hono`
// with a tenant-injecting middleware, every port a plain fake.
//
// GAP PINS (CL-7585): the per-workflow `buildJson` closures died with
// the seeding package and have no native home yet, so the builder
// answers `undefined` for every asset name and each formerly-deployable
// block 404s below. These tests pin that gap in the open — no silent
// no-op, no fake deploy. When the follow-up lane lands the builders'
// new home, the 404s become deploys again and these pins flip back to
// the deploy assertions. Dropped until then: the already-deployed 200
// (no deployable name can reach the deploy port) and the failing-deploy
// 500 (the route's catch branch is dead while no builder returns a
// real source).
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
  test("every formerly-deployable block answers 404 while the builders have no home, deploying nothing", async () => {
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
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("not_found");
    }
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
