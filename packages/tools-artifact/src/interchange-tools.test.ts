import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { HUB_RPC_ENV_KEY } from '@workbench/tool-credentials';
import { artifact } from './interchange-tools';

// The `interchange.tools` entry is the contract the sidecar loader imports
// and wires into the reactor: a hub-backed package must declare the hub-RPC
// requirement and expose all of its tool definitions.

const ctx = {
  baseURL: 'https://hub.test',
  token: 'sidecar-tok',
  tenantId: 't1',
  agentId: 'a1',
  principalId: 'p1',
  sessionId: 's1',
};

const env = { [HUB_RPC_ENV_KEY]: ctx } as unknown as BaseEnv;

describe('tools-artifact interchange.tools entry', () => {
  test('exports a namespaced AnnotatedToolFactory requiring the hub-RPC context', () => {
    expect(typeof artifact).toBe('function');
    expect(artifact.id).toBe('@workbench/tools-artifact/artifact');
    expect(artifact.requires).toEqual([HUB_RPC_ENV_KEY]);
  });

  test('the bundle exposes all 8 artifact definitions', () => {
    const names = artifact(env)
      .definitions.map((d) => d.name)
      .sort();
    expect(names).toEqual(
      [
        'artifact_create',
        'artifact_find_by_title',
        'artifact_link_file',
        'artifact_link_presentation',
        'artifact_list',
        'artifact_read',
        'artifact_write',
        'write_artifact',
      ].sort()
    );
  });
});
