import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { HUB_RPC_ENV_KEY } from '@workbench/tool-credentials';
import { dispatch } from './interchange-tools';

const ctx = {
  baseURL: 'https://hub.test',
  token: 'sidecar-tok',
  tenantId: 't1',
  agentId: 'a1',
  principalId: 'p1',
  sessionId: 's1',
};

const env = { [HUB_RPC_ENV_KEY]: ctx } as unknown as BaseEnv;

describe('tools-dispatch interchange.tools entry', () => {
  test('exports a namespaced hub-backed AnnotatedToolFactory', () => {
    expect(typeof dispatch).toBe('function');
    expect(dispatch.id).toBe('@workbench/tools-dispatch/dispatch');
    expect(dispatch.requires).toEqual([HUB_RPC_ENV_KEY]);
  });

  test('the bundle exposes dispatch_agent', () => {
    expect(dispatch(env).definitions.map((d) => d.name)).toEqual(['dispatch_agent']);
  });
});
