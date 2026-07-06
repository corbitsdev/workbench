import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { GrantStore } from "@intx/types/authz";
import type { SidecarRouter } from "@intx/hub-sessions";

// ── Boundary mocks ──────────────────────────────────────────────────
// The personal-agent sync orchestrates provisioning + grant reconcile. We mock
// those service boundaries and assert the orchestration itself: it provisions
// the Myra ROW and reconciles grants, and — the CL-2793 contract — it NEVER
// launches or relaunches a session. There is no session-launch dependency to
// mock precisely because the eager relaunch was removed; the behavioral proof
// is that a COLD (unroutable) instance is reconciled without a live push.

const ensureMember = mock(
  async (_db: unknown, opts: { tenantId: string; userId: string }) => ({
    tenantId: "tenant_global",
    principalId: "prin_member",
    userId: opts.userId,
  }),
);

let provisionCalls = 0;
const provisionMemberInstances = mock(async () => {
  provisionCalls += 1;
  return [{ templateKey: "myra", instanceId: "inst_myra_new" }];
});

const getMyraInstanceId = mock(
  (instances: { templateKey: string; instanceId: string }[]) =>
    instances.find((i) => i.templateKey === "myra")?.instanceId ?? null,
);

mock.module("../lib/tenant-provisioning", () => ({
  ensureMember,
  provisionMemberInstances,
  getMyraInstanceId,
}));

type RefreshCall = { hasLiveDeps: boolean; agentId: string };
const refreshCalls: RefreshCall[] = [];
let refreshResult = { refreshed: true, pushed: false };
const refreshInstanceGrantsFromDefinition = mock(
  async (
    _db: unknown,
    instance: { agentId: string },
    live?: { sidecarRouter: unknown; grantStore: unknown },
  ) => {
    refreshCalls.push({
      hasLiveDeps: live !== undefined,
      agentId: instance.agentId,
    });
    return refreshResult;
  },
);

mock.module("./grant-reconcile", () => ({
  refreshInstanceGrantsFromDefinition,
}));

const { syncPersonalAgentForUser } = await import("./sync-personal-agent");

// ── Fakes ───────────────────────────────────────────────────────────
type FakeDbOpts = {
  existingMyraInstanceId: string | null;
  instanceRow: {
    id: string;
    agentId: string;
    tenantId: string;
    principalId: string;
    address: string;
  } | null;
};

function makeDb(opts: FakeDbOpts) {
  return {
    query: {
      memberAgentInstance: {
        findFirst: async () =>
          opts.existingMyraInstanceId === null
            ? undefined
            : { instanceId: opts.existingMyraInstanceId },
      },
      agentInstance: {
        findFirst: async () => opts.instanceRow ?? undefined,
      },
    },
  } as never;
}

function makeSidecarRouter(routable: string[]): SidecarRouter {
  return {
    getRoutableAddresses: () => routable,
  } as unknown as SidecarRouter;
}

const grantStore = {} as GrantStore;
const ROOT = "tenant_global";
const INSTANCE_ROW = {
  id: "inst_myra_new",
  agentId: "agent_myra",
  tenantId: "tenant_global",
  principalId: "prin_myra",
  address: "myra@global.example.com",
};

beforeEach(() => {
  provisionCalls = 0;
  refreshCalls.length = 0;
  refreshResult = { refreshed: true, pushed: false };
  provisionMemberInstances.mockClear();
  refreshInstanceGrantsFromDefinition.mockClear();
});

describe("syncPersonalAgentForUser", () => {
  it("provisions the Myra instance row and reconciles grants without a live push when cold", async () => {
    const db = makeDb({
      existingMyraInstanceId: null,
      instanceRow: INSTANCE_ROW,
    });
    const sidecarRouter = makeSidecarRouter([]); // cold — not routable

    const outcome = await syncPersonalAgentForUser(
      { db, rootTenantId: ROOT, grantStore, sidecarRouter },
      "user_1",
    );

    // ROW provisioned (first join)
    expect(provisionCalls).toBe(1);
    expect(outcome.paInstanceId).toBe("inst_myra_new");
    expect(outcome.provisionedMyra).toBe(true);

    // Grants reconciled, but with NO live deps — a cold instance is not pushed
    // to a sidecar and no session is launched (CL-2793 lazy contract).
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.hasLiveDeps).toBe(false);
    expect(outcome.grantsRefreshed).toBe(true);
    expect(outcome.grantsPushedLive).toBe(false);
  });

  it("reuses an existing Myra instance instead of re-provisioning", async () => {
    const db = makeDb({
      existingMyraInstanceId: "inst_myra_existing",
      instanceRow: { ...INSTANCE_ROW, id: "inst_myra_existing" },
    });
    const sidecarRouter = makeSidecarRouter([]);

    const outcome = await syncPersonalAgentForUser(
      { db, rootTenantId: ROOT, grantStore, sidecarRouter },
      "user_1",
    );

    expect(provisionCalls).toBe(0);
    expect(outcome.paInstanceId).toBe("inst_myra_existing");
    expect(outcome.provisionedMyra).toBe(false);
    expect(refreshCalls).toHaveLength(1);
  });

  it("pushes grants live only when the instance is already routable", async () => {
    refreshResult = { refreshed: true, pushed: true };
    const db = makeDb({
      existingMyraInstanceId: "inst_myra_existing",
      instanceRow: { ...INSTANCE_ROW, id: "inst_myra_existing" },
    });
    const sidecarRouter = makeSidecarRouter([INSTANCE_ROW.address]); // already warm

    const outcome = await syncPersonalAgentForUser(
      { db, rootTenantId: ROOT, grantStore, sidecarRouter },
      "user_1",
    );

    // Already-warm instance: reconcile passes live deps so the grant delta
    // reaches the running sidecar. We still never launch — routability is only
    // observed, never forced.
    expect(refreshCalls[0]?.hasLiveDeps).toBe(true);
    expect(outcome.grantsPushedLive).toBe(true);
  });

  it("returns an empty outcome when member bootstrap fails", async () => {
    ensureMember.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const db = makeDb({ existingMyraInstanceId: null, instanceRow: null });

    const outcome = await syncPersonalAgentForUser(
      {
        db,
        rootTenantId: ROOT,
        grantStore,
        sidecarRouter: makeSidecarRouter([]),
      },
      "user_1",
    );

    expect(outcome.workingTenantId).toBeNull();
    expect(outcome.paInstanceId).toBeNull();
    expect(provisionCalls).toBe(0);
    expect(refreshCalls).toHaveLength(0);
  });
});
