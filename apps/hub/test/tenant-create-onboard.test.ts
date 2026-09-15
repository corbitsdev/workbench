// CL-7584: the tenant-create trigger. A 201 from `POST /api/tenants`
// fires exactly one fire-and-forget desired-state reconcile for the new
// tenant under the creator's minted session; a 403 fires none;
// concurrent kicks for the same tenant dedupe in-process; and a tenant
// with no catalog offerings logs blocked instead of throwing.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import type { ApiCall } from "@corbits/hub-api-client";
import type { WorkflowPusher } from "@corbits/seeding";
import type {
  ReconcileReport,
  reconcileTenantDesiredState,
} from "@workbench/onboarding/desired-state";
import {
  createTenantCreateObserver,
  type TenantCreateOnboardDeps,
} from "../src/tenant-create-onboard";

function harness(
  overrides: Omit<Partial<TenantCreateOnboardDeps>, "reconcileFn"> & {
    reconcileFn?: TenantCreateOnboardDeps["reconcileFn"] | undefined;
    reconcileStateFn?: typeof reconcileTenantDesiredState | undefined;
    nativeApp?: Hono<AppEnv>;
  } = {},
) {
  const logged: string[] = [];
  const reconciled: string[] = [];
  let cookiesSeenValue = "";
  const native =
    overrides.nativeApp ??
    new Hono<AppEnv>().post("/api/tenants", (c) =>
      c.json({ id: "ten_new", name: "New" }, 201),
    );

  const { nativeApp, ...depOverrides } = overrides;
  const deps = {
    api: (async () => {
      throw new Error("no hub calls expected with a reconcileFn stub");
    }) as unknown as ApiCall,
    hubUrl: "https://hub.example.com",
    pushWorkflow: (async () => ({
      outcome: "pushed",
      commitSha: "a".repeat(40),
    })) as unknown as WorkflowPusher,
    log: (line) => logged.push(line),
    reconcileFn: async (args) => {
      reconciled.push(args.tenantId);
      cookiesSeenValue = args.cookies.join(";");
      return {
        tenantId: args.tenantId,
        ready: true,
        pins: [{ name: "assistant", kind: "workflow", status: "installed" }],
      } satisfies ReconcileReport;
    },
    ...depOverrides,
  } as TenantCreateOnboardDeps;

  const cookiesSeen = () => cookiesSeenValue;
  const { app, kick } = createTenantCreateObserver(deps, native);
  return { app, kick, logged, reconciled, cookiesSeen };
}

describe("createTenantCreateObserver", () => {
  test("a 201 create fires one reconcile for the new tenant", async () => {
    const { app, reconciled, cookiesSeen } = harness();

    const response = await app.request("/api/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=creator",
      },
      body: JSON.stringify({ name: "New" }),
    });
    expect(response.status).toBe(201);
    // The kick is fire-and-forget but its collector is synchronous up
    // to the first await in the observer's own async work; yield once.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconciled).toEqual(["ten_new"]);
    expect(cookiesSeen()).toContain("better-auth.session_token=creator");
  });

  test("a 403 create fires nothing", async () => {
    const denied = new Hono<AppEnv>().post("/api/tenants", (c) =>
      c.json({ error: { code: "signup_not_allowed" } }, 403),
    );
    const { app, reconciled } = harness({ nativeApp: denied });

    const response = await app.request("/api/tenants", { method: "POST" });
    expect(response.status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconciled).toEqual([]);
  });

  test("concurrent creates of the same tenant dedupe to one reconcile", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstKick = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const { app } = harness({
      reconcileFn: async (args) => {
        calls += 1;
        if (calls === 1) await firstKick;
        return {
          tenantId: args.tenantId,
          ready: true,
          pins: [],
        };
      },
      nativeApp: new Hono<AppEnv>().post("/api/tenants", (c) =>
        c.json({ id: "ten_same" }, 201),
      ),
    });

    const request = () =>
      app.request("/api/tenants", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=creator" },
      });
    const first = request();
    const second = request();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("a tenant with no catalog offerings logs blocked instead of throwing", async () => {
    const api = (async (method: string, path: string) => {
      if (method === "GET" && path === "/api/tenants/ten_new/models") {
        return { status: 200, data: [], cookies: [] };
      }
      throw new Error(`stub api: unhandled ${method} ${path}`);
    }) as unknown as ApiCall;
    const { app, logged } = harness({
      api,
      reconcileFn:
        undefined as unknown as TenantCreateOnboardDeps["reconcileFn"],
    });

    await app.request("/api/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=creator",
      },
      body: JSON.stringify({ name: "New" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      logged.some(
        (line) => line.includes("ten_new") && line.includes("blocked"),
      ),
    ).toBe(true);
  });
});

// CL-7584: the production deployer path, DB-free. Past the
// model===undefined gate the observer resolves the creator's deploy
// identity (`resolveTenantDeployer`: GET /api/me/principals paginated +
// GET /api/tenants/:id) and hands principalId/tenantDomain to the
// reconcile seam — never a void-identity deploy when the session holds
// no deployable principal there.
describe("createTenantCreateObserver production deployer path", () => {
  const DEPLOYER_PRINCIPAL_ID = "prn_creator";
  const TENANT_DOMAIN = "new.bench.local";

  function principalsPayload(entries: {
    status: string;
    principalId?: string;
  }) {
    return {
      data: [
        {
          principalId: entries.principalId ?? DEPLOYER_PRINCIPAL_ID,
          tenantId: "ten_new",
          tenantName: "New",
          tenantSlug: "new",
          kind: "user",
          status: entries.status,
          roles: [],
        },
      ],
      nextCursor: null,
    };
  }

  function productionApi(principals: { data: unknown[]; nextCursor: null }) {
    const api = (async (method: string, path: string) => {
      if (method === "GET" && path === "/api/tenants/ten_new/models") {
        return {
          status: 200,
          data: [
            {
              id: "mdl_0",
              canonicalName: "llama3.2",
              offerings: [
                {
                  offeringId: "off_0",
                  providerId: "cpv_1",
                  providerName: "ollama",
                  plugin: "openai-compatible",
                  priority: 0,
                  deploymentTags: [],
                  capabilities: [],
                  pricing: [],
                },
              ],
            },
          ],
          cookies: [],
        };
      }
      if (method === "GET" && path === "/api/me/principals") {
        return { status: 200, data: principals, cookies: [] };
      }
      if (method === "GET" && path === "/api/tenants/ten_new") {
        return {
          status: 200,
          data: {
            id: "ten_new",
            name: "New",
            slug: "new",
            domain: TENANT_DOMAIN,
            parentId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`stub api: unhandled ${method} ${path}`);
    }) as unknown as ApiCall;
    return api;
  }

  function postCreate(app: Hono<AppEnv>) {
    return app.request("/api/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=creator",
      },
      body: JSON.stringify({ name: "New" }),
    });
  }

  // The kick is fire-and-forget behind the 201: the singleton lookup plus
  // paginated-principal fetch settles after the response is serialized.
  // Poll — never a fixed sleep — so the suite stays green when the whole
  // monorepo test leg runs packages in parallel.
  async function awaitSettled(done: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!done()) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("the creator's principalId and tenant domain reach the reconcile seam", async () => {
    const seen: {
      tenantId: string;
      principalId: string;
      domain: string;
      modelDefined: boolean;
    }[] = [];
    const reconcileStateFn: typeof reconcileTenantDesiredState = (async (
      args,
    ) => {
      seen.push({
        tenantId: args.tenant.tenantId,
        principalId: args.tenant.principalId,
        domain: args.tenant.domain,
        modelDefined: args.model !== undefined,
      });
      return {
        tenantId: args.tenant.tenantId,
        ready: true,
        pins: [],
      };
    }) as typeof reconcileTenantDesiredState;
    const { app, logged } = harness({
      api: productionApi(principalsPayload({ status: "active" })),
      reconcileFn:
        undefined as unknown as TenantCreateOnboardDeps["reconcileFn"],
      reconcileStateFn,
    });

    const response = await postCreate(app);
    expect(response.status).toBe(201);
    await awaitSettled(() => seen.length === 1);
    expect(seen).toEqual([
      {
        tenantId: "ten_new",
        principalId: DEPLOYER_PRINCIPAL_ID,
        domain: TENANT_DOMAIN,
        modelDefined: true,
      },
    ]);
    expect(
      logged.some((line) => line.includes("no deployable principal")),
    ).toBe(false);
  });

  test("a suspended principal never reaches the seam — blocked, never void-identity", async () => {
    let calls = 0;
    const reconcileStateFn: typeof reconcileTenantDesiredState = (async (
      args,
    ) => {
      calls += 1;
      return {
        tenantId: args.tenant.tenantId,
        ready: true,
        pins: [],
      };
    }) as typeof reconcileTenantDesiredState;
    const { app, logged } = harness({
      api: productionApi(principalsPayload({ status: "suspended" })),
      reconcileFn:
        undefined as unknown as TenantCreateOnboardDeps["reconcileFn"],
      reconcileStateFn,
    });

    const response = await postCreate(app);
    expect(response.status).toBe(201);
    await awaitSettled(() =>
      logged.some((line) => line.includes("no deployable principal")),
    );
    expect(calls).toBe(0);
    expect(
      logged.some((line) => line.includes("no deployable principal")),
    ).toBe(true);
  });

  test("no principal on the tenant never reaches the seam — blocked, never void-identity", async () => {
    let calls = 0;
    const reconcileStateFn: typeof reconcileTenantDesiredState = (async (
      args,
    ) => {
      calls += 1;
      return {
        tenantId: args.tenant.tenantId,
        ready: true,
        pins: [],
      };
    }) as typeof reconcileTenantDesiredState;
    const { app, logged } = harness({
      api: productionApi({ data: [], nextCursor: null }),
      reconcileFn:
        undefined as unknown as TenantCreateOnboardDeps["reconcileFn"],
      reconcileStateFn,
    });

    const response = await postCreate(app);
    expect(response.status).toBe(201);
    await awaitSettled(() =>
      logged.some((line) => line.includes("no deployable principal")),
    );
    expect(calls).toBe(0);
    expect(
      logged.some((line) => line.includes("no deployable principal")),
    ).toBe(true);
  });
});
