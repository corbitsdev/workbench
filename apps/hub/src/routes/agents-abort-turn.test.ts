import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";
import type {
  SessionService,
  SidecarRouter,
  EventCollectorRegistry,
} from "@workbench/hub-sessions";
import type { GrantStore } from "@intx/types/authz";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
    workflowDeploy: { modelSourceCacheTtlMs: 45_000 },
  }),
}));

import { Hono } from "hono";
import { createAgentProvisioningRouter } from "./agents";

const INSTANCE = {
  id: "ins_1",
  agentId: "agt_1",
  tenantId: "ten_1",
  principalId: "prn_agent",
  address: "ins_1@ten.example.com",
  status: "running",
};

const CALLER_PRINCIPAL = { id: "prn_user", tenantId: "ten_1", kind: "user" };

const MANAGE_GRANT = {
  resource: `instance:${INSTANCE.id}`,
  action: "manage",
  effect: "allow",
};

function makeDb(opts: { instance?: unknown; principal?: unknown } = {}) {
  return {
    query: {
      agentInstance: {
        findFirst: mock(() => Promise.resolve(opts.instance)),
      },
      principal: {
        findFirst: mock(() => Promise.resolve(opts.principal)),
      },
    },
  };
}

function makeGrantStore(grants: unknown[] = []): GrantStore {
  return {
    collectGrants: mock(() => Promise.resolve(grants)),
  } as unknown as GrantStore;
}

const mockSessionService = {} as unknown as SessionService;
const mockEventCollectors = {} as unknown as EventCollectorRegistry;

function makeSidecarRouter(): SidecarRouter & {
  sendSessionAbort: ReturnType<typeof mock>;
} {
  return {
    sendSessionAbort: mock(() => Promise.resolve()),
    getRoutableAddresses: mock(() => [] as string[]),
    events: { on: () => () => {} },
  } as unknown as SidecarRouter & { sendSessionAbort: ReturnType<typeof mock> };
}

function buildApp(
  db: ReturnType<typeof makeDb>,
  grantStore: GrantStore,
  sidecarRouter: SidecarRouter,
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  parent.route(
    "/",
    createAgentProvisioningRouter(
      db as unknown as DB["db"],
      mockSessionService,
      grantStore,
      sidecarRouter,
      mockEventCollectors,
    ),
  );
  return parent;
}

function abortRequest(instanceId: string): Request {
  return new Request(`http://test/instances/${instanceId}/abort-turn`, {
    method: "POST",
  });
}

describe("POST /instances/:instanceId/abort-turn", () => {
  it("404s for an unknown instance", async () => {
    const app = buildApp(makeDb(), makeGrantStore(), makeSidecarRouter());
    const res = await app.fetch(abortRequest("ins_missing"));
    expect(res.status).toBe(404);
  });

  it("403s when the caller has no manage grant on the instance", async () => {
    const router = makeSidecarRouter();
    const app = buildApp(
      makeDb({ instance: INSTANCE, principal: CALLER_PRINCIPAL }),
      makeGrantStore([]),
      router,
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    expect(res.status).toBe(403);
    expect(router.sendSessionAbort).not.toHaveBeenCalled();
  });

  it("409s with the runtime-unsupported message for an authorized caller, without contacting the sidecar", async () => {
    const router = makeSidecarRouter();
    const app = buildApp(
      makeDb({ instance: INSTANCE, principal: CALLER_PRINCIPAL }),
      makeGrantStore([MANAGE_GRANT]),
      router,
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Stopping a running turn is not available in this runtime",
    );
    expect(router.sendSessionAbort).not.toHaveBeenCalled();
  });
});
