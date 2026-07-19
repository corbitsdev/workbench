import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { AgentTemplate } from "@workbench/agents";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { GrantRule } from "@intx/types/authz";

mock.module("../config", () => ({
  getConfig: () => ({
    rootTenant: {
      slug: "global-org",
      name: "Global Org",
      domain: "global.example.com",
    },
  }),
  requireCredentialEncryptionKey: () => Buffer.alloc(32),
}));

mock.module("../lib/myra-member-tool-narrowing", () => ({
  narrowToolNamesForMemberMyraLaunch: async (
    _db: unknown,
    _tenantId: string,
    _instanceId: string,
    granted: readonly string[],
  ) => [...granted],
}));

const toolGrantCalls: { principalId: string; toolNames: string[] }[] = [];
const reqGrantCalls: { principalId: string }[] = [];
mock.module("./agent-provisioning", () => ({
  persistInstanceToolGrants: mock(
    async (
      _db: unknown,
      opts: { principalId: string; toolNames: string[] },
    ) => {
      toolGrantCalls.push({
        principalId: opts.principalId,
        toolNames: opts.toolNames,
      });
    },
  ),
  persistInstanceGrantRequirements: mock(
    async (_db: unknown, opts: { principalId: string }) => {
      reqGrantCalls.push({ principalId: opts.principalId });
    },
  ),
  resolveInstanceSourcesFromDefinition: mock(async () => ({
    ok: true as const,
    sources: [],
  })),
  launchAgentSession: mock(async () => ({})),
}));

const {
  reconcileMemberInstanceGrants,
  refreshInstanceGrantsFromDefinition,
  personalAgentUpdateAvailable,
  assessPersonalAgentSync,
} = await import("./grant-reconcile");

const { resetRelaunchBreaker, runDedupedRelaunch, setRelaunchBreakerClock } =
  await import("./relaunch-breaker");

const CANONICAL_TOOL = "@workbench/tools-granola/granola:granola_list_notes";

function makeGrantRule(resource: string, action: string): GrantRule {
  return {
    id: `grant-${resource}-${action}`,
    resource,
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

function makeSidecarRouter(
  used: Pick<SidecarRouter, "getRoutableAddresses">,
): SidecarRouter {
  const unused = (): never => {
    throw new Error("SidecarRouter method not stubbed for this test");
  };
  return new Proxy(used as SidecarRouter, {
    get(target, prop, receiver) {
      if (prop in used) return Reflect.get(target, prop, receiver);
      return unused;
    },
  });
}

const MYRA: AgentTemplate = {
  key: "myra",
  name: "Myra",
  description: "personal",
  systemPrompt: "",
  credentialRequirements: [],
  grantRequirements: [],
  capabilities: { tools: [CANONICAL_TOOL] },
  kind: "personal",
};

type FakeOpts = {
  tenant?: { id: string } | undefined;
  def?:
    | { id: string; capabilities: unknown; grantRequirements: unknown }
    | undefined;
  mappings?: { instanceId: string }[];
};

function fakeDb(opts: FakeOpts) {
  return {
    query: {
      tenant: { findFirst: async () => opts.tenant },
      agent: { findFirst: async () => opts.def },
      agentInstance: { findFirst: async () => undefined },
      memberAgentInstance: { findMany: async () => opts.mappings ?? [] },
    },
  } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];
}

beforeEach(() => {
  toolGrantCalls.length = 0;
  reqGrantCalls.length = 0;
});

describe("reconcileMemberInstanceGrants", () => {
  it("returns nothing and writes no grants when the definition is missing", async () => {
    const db = fakeDb({ tenant: { id: "ten-1" }, def: undefined });
    const results = await reconcileMemberInstanceGrants(db, "ten-1", [MYRA]);
    expect(results).toEqual([]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  it("skips a template that has no member instances", async () => {
    const db = fakeDb({
      tenant: { id: "ten-1" },
      def: {
        id: "agt-1",
        capabilities: { tools: [CANONICAL_TOOL] },
        grantRequirements: [],
      },
      mappings: [],
    });
    const results = await reconcileMemberInstanceGrants(db, "ten-1", [MYRA]);
    expect(results).toEqual([]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  it("rewrites each member instance to the definition canonical tool names", async () => {
    const byId: Record<
      string,
      { id: string; principalId: string; address: string }
    > = {
      "ins-1": {
        id: "ins-1",
        principalId: "prn-1",
        address: "a1@global.example.com",
      },
      "ins-2": {
        id: "ins-2",
        principalId: "prn-2",
        address: "a2@global.example.com",
      },
    };
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: "ten-1" }) },
        agent: {
          findFirst: async () => ({
            id: "agt-1",
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: {
          findFirst: async (q: { where: { queryChunks?: unknown } }) => {
            // resolve by matching one of the known ids in insertion order
            const remaining = Object.keys(byId).filter((k) => !resolved.has(k));
            const id = remaining[0];
            void q;
            if (id === undefined) return undefined;
            resolved.add(id);
            return byId[id];
          },
        },
        memberAgentInstance: {
          findMany: async () => [
            { instanceId: "ins-1" },
            { instanceId: "ins-2" },
          ],
        },
      },
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];
    const resolved = new Set<string>();

    const results = await reconcileMemberInstanceGrants(db, "ten-1", [MYRA]);

    expect(results).toEqual([
      { templateKey: "myra", reconciled: 2, pushed: 0, skipped: 0 },
    ]);
    expect(toolGrantCalls).toHaveLength(2);
    expect(toolGrantCalls.map((c) => c.toolNames)).toEqual([
      [CANONICAL_TOOL],
      [CANONICAL_TOOL],
    ]);
    expect(toolGrantCalls.map((c) => c.principalId).sort()).toEqual([
      "prn-1",
      "prn-2",
    ]);
    expect(reqGrantCalls).toHaveLength(2);
  });

  it("counts a missing agent_instance row as skipped, not reconciled", async () => {
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: "ten-1" }) },
        agent: {
          findFirst: async () => ({
            id: "agt-1",
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: { findFirst: async () => undefined },
        memberAgentInstance: {
          findMany: async () => [{ instanceId: "ins-gone" }],
        },
      },
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];

    const results = await reconcileMemberInstanceGrants(db, "ten-1", [MYRA]);
    expect(results).toEqual([
      { templateKey: "myra", reconciled: 0, pushed: 0, skipped: 1 },
    ]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  // BEHAVIOR CHANGE (runtime retirement): the live grants-push transport
  // (`grants.update`) is gone, so a reconcile never live-pushes — it persists
  // the new grant set (picked up on the instance's next deploy) and always
  // reports `pushed: 0`, routable or not.
  it("persists grants and never live-pushes (transport retired)", async () => {
    const collectGrants = mock(async () => [
      { resource: "tool:x", action: "invoke" },
    ]);
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: "ten-1" }) },
        agent: {
          findFirst: async () => ({
            id: "agt-1",
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: {
          findFirst: async () => ({
            id: "ins-1",
            principalId: "prn-1",
            address: "live@global.example.com",
          }),
        },
        memberAgentInstance: {
          findMany: async () => [{ instanceId: "ins-1" }],
        },
      },
      update: () => ({ set: () => ({ where: mock(async () => {}) }) }),
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];

    const live = {
      sidecarRouter: {
        getRoutableAddresses: () => ["live@global.example.com"],
      },
      grantStore: {
        collectGrants,
        collectGrantsInChain: collectGrants,
      },
    } as never;

    const [result] = await reconcileMemberInstanceGrants(
      db,
      "ten-1",
      [MYRA],
      live,
    );
    expect(result).toEqual({
      templateKey: "myra",
      reconciled: 1,
      pushed: 0,
      skipped: 0,
    });
  });
});

describe("refreshInstanceGrantsFromDefinition", () => {
  // BEHAVIOR CHANGE (runtime retirement): grants are rewritten in the DB but
  // never live-pushed (the `grants.update` transport is gone), so `pushed` is
  // always false regardless of routability. The instance picks up the new set
  // on its next deploy/reconnect.
  it("rewrites DB grants but never live-pushes (routable)", async () => {
    const collectGrants = mock(async () => [
      makeGrantRule("tool:attio_query_records", "invoke"),
    ]);
    const update = mock(async () => {});
    const db = {
      query: {
        agent: {
          findFirst: async () => ({
            id: "agt-1",
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: { findFirst: async () => undefined },
      },
      update: () => ({ set: () => ({ where: update }) }),
    } as unknown as Parameters<typeof refreshInstanceGrantsFromDefinition>[0];

    const result = await refreshInstanceGrantsFromDefinition(
      db,
      {
        agentId: "agt-1",
        tenantId: "ten-1",
        principalId: "prn-1",
        address: "live@global.example.com",
      },
      {
        sidecarRouter: makeSidecarRouter({
          getRoutableAddresses: () => ["live@global.example.com"],
        }),
        grantStore: {
          collectGrants,
          collectGrantsInChain: collectGrants,
        },
      },
    );

    expect(result).toEqual({ refreshed: true, pushed: false });
    expect(toolGrantCalls).toHaveLength(1);
  });

  it("rewrites DB grants but does not push when not routable", async () => {
    const collectGrants = mock(async (): Promise<GrantRule[]> => []);
    const db = {
      query: {
        agent: {
          findFirst: async () => ({
            id: "agt-1",
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: { findFirst: async () => undefined },
      },
    } as unknown as Parameters<typeof refreshInstanceGrantsFromDefinition>[0];

    const result = await refreshInstanceGrantsFromDefinition(
      db,
      {
        agentId: "agt-1",
        tenantId: "ten-1",
        principalId: "prn-1",
        address: "down@global.example.com",
      },
      {
        sidecarRouter: makeSidecarRouter({
          getRoutableAddresses: () => [],
        }),
        grantStore: {
          collectGrants,
          collectGrantsInChain: collectGrants,
        },
      },
    );

    expect(result).toEqual({ refreshed: true, pushed: false });
    expect(toolGrantCalls).toHaveLength(1);
  });
});

describe("personalAgentUpdateAvailable", () => {
  it("is true when paInstanceId is missing", async () => {
    expect(await personalAgentUpdateAvailable({} as never, null)).toBe(true);
  });

  it("assessPersonalAgentSync returns a reason when sync is needed", async () => {
    const assessment = await assessPersonalAgentSync({} as never, null);
    expect(assessment).toEqual({ available: true, reason: "no_myra_instance" });
  });
});

describe("assessPersonalAgentSync — relaunch cooldown", () => {
  beforeEach(() => {
    resetRelaunchBreaker();
  });

  it("settles available:false during the post-failure cooldown so the client stops re-firing", async () => {
    // An instance that would otherwise be reported as needing sync (the row is
    // absent → 'no_myra_instance', available:true). Arm the breaker for it and
    // the assessment must flip to available:false to close the poll loop.
    setRelaunchBreakerClock(() => 1_000_000);
    await runDedupedRelaunch("ins-cooldown", () =>
      Promise.reject(new Error("launch boom")),
    ).catch(() => {});

    const db = {
      query: {
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    } as unknown as Parameters<typeof assessPersonalAgentSync>[0];

    const assessment = await assessPersonalAgentSync(db, "ins-cooldown");
    expect(assessment.available).toBe(false);
    expect(assessment.reason).toBe("recent_launch_failure");
  });

  it("does not suppress sync once the cooldown has elapsed", async () => {
    let nowMs = 2_000_000;
    setRelaunchBreakerClock(() => nowMs);
    await runDedupedRelaunch("ins-elapsed", () =>
      Promise.reject(new Error("launch boom")),
    ).catch(() => {});
    nowMs += 30_000;

    const db = {
      query: {
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    } as unknown as Parameters<typeof assessPersonalAgentSync>[0];
    const assessment = await assessPersonalAgentSync(db, "ins-elapsed");
    // Cooldown elapsed → assessment falls through to its normal verdict
    // (instance row absent → needs sync).
    expect(assessment.available).toBe(true);
    expect(assessment.reason).toBe("no_myra_instance");
  });
});
