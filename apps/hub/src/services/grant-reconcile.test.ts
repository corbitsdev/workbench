import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { AgentTemplate } from '@workbench/agents';

mock.module('../config', () => ({
  getConfig: () => ({
    globalTenant: { slug: 'global-org', name: 'Global Org', domain: 'global.example.com' },
  }),
}));

const toolGrantCalls: Array<{ principalId: string; toolNames: string[] }> = [];
const reqGrantCalls: Array<{ principalId: string }> = [];
mock.module('./agent-provisioning', () => ({
  persistInstanceToolGrants: mock(
    async (_db: unknown, opts: { principalId: string; toolNames: string[] }) => {
      toolGrantCalls.push({ principalId: opts.principalId, toolNames: opts.toolNames });
    }
  ),
  persistInstanceGrantRequirements: mock(async (_db: unknown, opts: { principalId: string }) => {
    reqGrantCalls.push({ principalId: opts.principalId });
  }),
}));

const {
  reconcileMemberInstanceGrants,
  refreshInstanceGrantsFromDefinition,
  personalAgentUpdateAvailable,
  assessPersonalAgentSync,
} = await import('./grant-reconcile');

const CANONICAL_TOOL = '@workbench/tools-granola/granola:granola_list_notes';

const MYRA: AgentTemplate = {
  key: 'myra',
  name: 'Myra',
  description: 'personal',
  systemPrompt: '',
  credentialRequirements: [],
  grantRequirements: [],
  capabilities: { tools: [CANONICAL_TOOL] },
  kind: 'personal',
};

type FakeOpts = {
  tenant?: { id: string } | undefined;
  def?: { id: string; capabilities: unknown; grantRequirements: unknown } | undefined;
  mappings?: Array<{ instanceId: string }>;
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

describe('reconcileMemberInstanceGrants', () => {
  it('returns nothing and writes no grants when the global tenant is missing', async () => {
    const db = fakeDb({ tenant: undefined });
    const results = await reconcileMemberInstanceGrants(db, [MYRA]);
    expect(results).toEqual([]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  it('skips a template that has no member instances', async () => {
    const db = fakeDb({
      tenant: { id: 'ten-1' },
      def: { id: 'agt-1', capabilities: { tools: [CANONICAL_TOOL] }, grantRequirements: [] },
      mappings: [],
    });
    const results = await reconcileMemberInstanceGrants(db, [MYRA]);
    expect(results).toEqual([]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  it('rewrites each member instance to the definition canonical tool names', async () => {
    const byId: Record<string, { id: string; principalId: string; address: string }> = {
      'ins-1': { id: 'ins-1', principalId: 'prn-1', address: 'a1@global.example.com' },
      'ins-2': { id: 'ins-2', principalId: 'prn-2', address: 'a2@global.example.com' },
    };
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: 'ten-1' }) },
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
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
          findMany: async () => [{ instanceId: 'ins-1' }, { instanceId: 'ins-2' }],
        },
      },
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];
    const resolved = new Set<string>();

    const results = await reconcileMemberInstanceGrants(db, [MYRA]);

    expect(results).toEqual([{ templateKey: 'myra', reconciled: 2, pushed: 0, skipped: 0 }]);
    expect(toolGrantCalls).toHaveLength(2);
    expect(toolGrantCalls.map((c) => c.toolNames)).toEqual([[CANONICAL_TOOL], [CANONICAL_TOOL]]);
    expect(toolGrantCalls.map((c) => c.principalId).sort()).toEqual(['prn-1', 'prn-2']);
    expect(reqGrantCalls).toHaveLength(2);
  });

  it('counts a missing agent_instance row as skipped, not reconciled', async () => {
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: 'ten-1' }) },
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: { findFirst: async () => undefined },
        memberAgentInstance: { findMany: async () => [{ instanceId: 'ins-gone' }] },
      },
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];

    const results = await reconcileMemberInstanceGrants(db, [MYRA]);
    expect(results).toEqual([{ templateKey: 'myra', reconciled: 0, pushed: 0, skipped: 1 }]);
    expect(toolGrantCalls).toHaveLength(0);
  });

  it('pushes a grants update only to live (routable) instances', async () => {
    const sendGrantsUpdate = mock(async () => {});
    const collectGrants = mock(async () => [{ resource: 'tool:x', action: 'invoke' }]);
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: 'ten-1' }) },
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: {
          findFirst: async () => ({
            id: 'ins-1',
            principalId: 'prn-1',
            address: 'live@global.example.com',
          }),
        },
        memberAgentInstance: { findMany: async () => [{ instanceId: 'ins-1' }] },
      },
      update: () => ({ set: () => ({ where: mock(async () => {}) }) }),
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];

    const live = {
      sidecarRouter: {
        getRoutableAddresses: () => ['live@global.example.com'],
        sendGrantsUpdate,
      },
      grantStore: { collectGrants },
    } as never;

    const [result] = await reconcileMemberInstanceGrants(db, [MYRA], live);
    expect(result).toEqual({ templateKey: 'myra', reconciled: 1, pushed: 1, skipped: 0 });
    expect(sendGrantsUpdate).toHaveBeenCalledTimes(1);
    expect(collectGrants).toHaveBeenCalledTimes(1);
  });

  it('does not push when the instance is not routable', async () => {
    const sendGrantsUpdate = mock(async () => {});
    const collectGrants = mock(async () => []);
    const db = {
      query: {
        tenant: { findFirst: async () => ({ id: 'ten-1' }) },
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
        agentInstance: {
          findFirst: async () => ({
            id: 'ins-1',
            principalId: 'prn-1',
            address: 'down@global.example.com',
          }),
        },
        memberAgentInstance: { findMany: async () => [{ instanceId: 'ins-1' }] },
      },
    } as unknown as Parameters<typeof reconcileMemberInstanceGrants>[0];

    const live = {
      sidecarRouter: { getRoutableAddresses: () => [], sendGrantsUpdate },
      grantStore: { collectGrants },
    } as never;

    const [result] = await reconcileMemberInstanceGrants(db, [MYRA], live);
    expect(result).toEqual({ templateKey: 'myra', reconciled: 1, pushed: 0, skipped: 0 });
    expect(sendGrantsUpdate).not.toHaveBeenCalled();
  });
});

describe('refreshInstanceGrantsFromDefinition', () => {
  it('pushes grants when live and routable', async () => {
    const sendGrantsUpdate = mock(async () => {});
    const collectGrants = mock(async () => [
      { resource: 'tool:attio_query_records', action: 'invoke' },
    ]);
    const update = mock(async () => {});
    const db = {
      query: {
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
      },
      update: () => ({ set: () => ({ where: update }) }),
    } as unknown as Parameters<typeof refreshInstanceGrantsFromDefinition>[0];

    const result = await refreshInstanceGrantsFromDefinition(
      db,
      {
        agentId: 'agt-1',
        tenantId: 'ten-1',
        principalId: 'prn-1',
        address: 'live@global.example.com',
      },
      {
        sidecarRouter: {
          getRoutableAddresses: () => ['live@global.example.com'],
          sendGrantsUpdate,
        },
        grantStore: { collectGrants },
      }
    );

    expect(result).toEqual({ refreshed: true, pushed: true });
    expect(toolGrantCalls).toHaveLength(1);
    expect(sendGrantsUpdate).toHaveBeenCalledTimes(1);
  });

  it('rewrites DB grants but does not push when not routable', async () => {
    const sendGrantsUpdate = mock(async () => {});
    const db = {
      query: {
        agent: {
          findFirst: async () => ({
            id: 'agt-1',
            capabilities: { tools: [CANONICAL_TOOL] },
            grantRequirements: [],
          }),
        },
      },
    } as unknown as Parameters<typeof refreshInstanceGrantsFromDefinition>[0];

    const result = await refreshInstanceGrantsFromDefinition(
      db,
      {
        agentId: 'agt-1',
        tenantId: 'ten-1',
        principalId: 'prn-1',
        address: 'down@global.example.com',
      },
      {
        sidecarRouter: { getRoutableAddresses: () => [], sendGrantsUpdate },
        grantStore: { collectGrants: mock(async () => []) },
      }
    );

    expect(result).toEqual({ refreshed: true, pushed: false });
    expect(toolGrantCalls).toHaveLength(1);
    expect(sendGrantsUpdate).not.toHaveBeenCalled();
  });
});

describe('personalAgentUpdateAvailable', () => {
  it('is true when paInstanceId is missing', async () => {
    expect(await personalAgentUpdateAvailable({} as never, null)).toBe(true);
  });

  it('assessPersonalAgentSync returns a reason when sync is needed', async () => {
    const assessment = await assessPersonalAgentSync({} as never, null);
    expect(assessment).toEqual({ available: true, reason: 'no_myra_instance' });
  });
});
