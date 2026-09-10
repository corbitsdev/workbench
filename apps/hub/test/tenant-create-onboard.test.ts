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
import type { ReconcileReport } from "@workbench/onboarding/desired-state";
import {
  createTenantCreateObserver,
  type TenantCreateOnboardDeps,
} from "../src/tenant-create-onboard";

function harness(
  overrides: Omit<Partial<TenantCreateOnboardDeps>, "reconcileFn"> & {
    reconcileFn?: TenantCreateOnboardDeps["reconcileFn"] | undefined;
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
