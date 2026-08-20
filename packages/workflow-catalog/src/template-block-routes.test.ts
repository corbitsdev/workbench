// Exercises `createTemplateBlockRoutes`' HTTP surface through the real
// `buildBlockWorkflowSource` builder, mounted the same way
// `./connect-github-routes.test.ts` mounts its routes: a bare `Hono`
// with a tenant-injecting middleware, every port a plain fake.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

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
  test("deploys the code-review block as a source-form definition carrying the github tool pin", async () => {
    const { app, deployed } = buildApp();
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "wfd_code_review", created: true });

    expect(deployed).toHaveLength(1);
    const source = deployed[0];
    if (source === undefined) throw new Error("nothing deployed");
    expect(source.tenantId).toBe(TENANT.id);
    expect(source.principalId).toBe(PRINCIPAL.id);
    expect(source.assetName).toBe("code-review");
    expect(source.displayName).toBe("Code review");

    const definition = JSON.parse(source.workflowJson) as {
      triggers: { type: string; to: string }[];
      steps: Record<
        string,
        { agent: { toolPackagePins?: { name: string }[] } }
      >;
    };
    expect(definition.triggers).toEqual([
      { type: "mail", to: "code-review@acme.example" },
    ]);
    const pins = Object.values(definition.steps).flatMap(
      (step) => step.agent.toolPackagePins ?? [],
    );
    expect(pins.map((pin) => pin.name)).toContain("@corbits/github-tools");
  });

  test("an already-deployed block answers 200 with created: false", async () => {
    const { app } = buildApp({
      deployWorkflowSource: async () => ({
        id: "wfd_existing",
        created: false,
      }),
    });
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "wfd_existing", created: false });
  });

  test("an asset name no block builder covers answers 404, deploying nothing", async () => {
    const { app, deployed } = buildApp();
    const res = await app.request("/granola-call/deploy", { method: "POST" });
    expect(res.status).toBe(404);
    expect(deployed).toHaveLength(0);
  });

  test("a failing deploy port answers a 500 envelope, never a raw error", async () => {
    const { app } = buildApp({
      deployWorkflowSource: async () => {
        throw new Error("disk full");
      },
    });
    const res = await app.request("/code-review/deploy", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { userMessage?: string } };
    expect(JSON.stringify(body)).not.toContain("disk full");
  });
});
