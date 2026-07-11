import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";
import type {
  SessionService,
  SidecarRouter,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
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

function makeSidecarRouter(
  sendSessionAbort: (address: string, reason: string) => Promise<void> = () =>
    Promise.resolve(),
): SidecarRouter & { sendSessionAbort: ReturnType<typeof mock> } {
  return {
    sendSessionAbort: mock(sendSessionAbort),
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

  it("404s (not 403) when the caller is not a principal of the instance tenant", async () => {
    const app = buildApp(
      makeDb({ instance: INSTANCE }),
      makeGrantStore([MANAGE_GRANT]),
      makeSidecarRouter(),
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    // Identical to not-found so instance ids in other tenants cannot be
    // enumerated (same contract as the session-launch route).
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

  it("sends the extended user_stop_turn abort for the instance address and 204s", async () => {
    const router = makeSidecarRouter();
    const grantStore = makeGrantStore([MANAGE_GRANT]);
    const app = buildApp(
      makeDb({ instance: INSTANCE, principal: CALLER_PRINCIPAL }),
      grantStore,
      router,
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    expect(res.status).toBe(204);
    expect(router.sendSessionAbort).toHaveBeenCalledTimes(1);
    // Never user_disconnect (or any upstream AbortReason) — those stay
    // terminal on the sidecar; only the workbench extension is non-terminal.
    expect(router.sendSessionAbort.mock.calls[0]).toEqual([
      INSTANCE.address,
      "user_stop_turn",
    ]);
  });

  it("409s when the sidecar reports no running turn", async () => {
    const router = makeSidecarRouter(() =>
      Promise.reject(new Error(`no-active-turn: ${INSTANCE.address}`)),
    );
    const app = buildApp(
      makeDb({ instance: INSTANCE, principal: CALLER_PRINCIPAL }),
      makeGrantStore([MANAGE_GRANT]),
      router,
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("No running turn");
  });

  it("502s when the sidecar is unreachable", async () => {
    const router = makeSidecarRouter(() =>
      Promise.reject(new Error('No sidecar connected for agent "x"')),
    );
    const app = buildApp(
      makeDb({ instance: INSTANCE, principal: CALLER_PRINCIPAL }),
      makeGrantStore([MANAGE_GRANT]),
      router,
    );
    const res = await app.fetch(abortRequest(INSTANCE.id));
    expect(res.status).toBe(502);
  });
});
