import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { HUB_RPC_ENV_KEY } from '@workbench/tool-credentials';
import { agents } from './interchange-tools';

const ctx = {
  baseURL: 'https://hub.test',
  token: 'sidecar-tok',
  tenantId: 't1',
  agentId: 'a1',
  principalId: 'p1',
  sessionId: 's1',
};

const env = { [HUB_RPC_ENV_KEY]: ctx } as unknown as BaseEnv;

describe('tools-agents interchange.tools entry', () => {
  test('exports a namespaced hub-backed AnnotatedToolFactory', () => {
    expect(typeof agents).toBe('function');
    expect(agents.id).toBe('@workbench/tools-agents/agents');
    expect(agents.requires).toEqual([HUB_RPC_ENV_KEY]);
  });

  test('the bundle exposes list_principals and list_agents', () => {
    const names = agents(env)
      .definitions.map((d) => d.name)
      .sort();
    expect(names).toEqual(['list_agents', 'list_principals']);
  });
});
