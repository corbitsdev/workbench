import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as intxDb from '@intx/db';
import { LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { HubDb } from '../db';

// resolveCredentialRequirement now returns a raw credential row (or null);
// resolveWorkflowDeployConfig builds the InferenceSource itself from the row
// plus the provider's metadata.baseURL.
let credentialRow: unknown = {
  id: 'cred1',
  providerId: 'prov1',
  secret: 'k',
};
const resolveCredentialRequirement = mock(async () => credentialRow);
mock.module('@intx/db', () => ({ ...intxDb, resolveCredentialRequirement }));

const { resolveWorkflowDeployConfig } = await import('./workflow-deploy-config');

afterAll(() => {
  mock.restore();
});

function makeDb(provider: unknown): HubDb {
  return {
    query: {
      provider: { findFirst: async () => provider },
    },
  } as unknown as HubDb;
}

const args = {
  tenantId: 'ten',
  principalId: 'prn',
  deploymentDomain: 'local',
};

describe('resolveWorkflowDeployConfig', () => {
  test('builds a base config carrying an inference source from the credential row', async () => {
    credentialRow = { id: 'cred1', providerId: 'prov1', secret: 'k' };
    const db = makeDb({
      id: 'prov1',
      plugin: 'openai-compatible',
      name: 'LLM',
      metadata: { baseURL: 'http://llm' },
    });

    const result = await resolveWorkflowDeployConfig({ ...args, db });

    expect(result.config.sources).toEqual([
      {
        id: `openai-compatible:${LLM_DEFAULT_MODEL}`,
        provider: 'openai-compatible',
        baseURL: 'http://llm',
        apiKey: 'k',
        model: LLM_DEFAULT_MODEL,
      },
    ]);
    expect(result.config.defaultSource).toBe(`openai-compatible:${LLM_DEFAULT_MODEL}`);
    expect(result.config.tenantId).toBe('ten');
    expect(result.config.principalId).toBe('prn');
    expect(result.config.agentAddress).toBe(`${result.deploymentId}@local`);
    expect(result.config.agentId).toBe(result.deploymentId);
  });

  test('throws a clear error when the tenant LLM credential is missing', async () => {
    credentialRow = null;
    await expect(
      resolveWorkflowDeployConfig({ ...args, db: makeDb(undefined) })
    ).rejects.toThrow(/cannot resolve LLM credential/);
  });

  test('throws when the provider for the credential cannot be found', async () => {
    credentialRow = { id: 'cred1', providerId: 'prov1', secret: 'k' };
    await expect(
      resolveWorkflowDeployConfig({ ...args, db: makeDb(undefined) })
    ).rejects.toThrow(/provider .* not found/);
  });

  test('throws when the provider metadata lacks a baseURL', async () => {
    credentialRow = { id: 'cred1', providerId: 'prov1', secret: 'k' };
    const db = makeDb({ id: 'prov1', plugin: 'openai-compatible', name: 'LLM', metadata: {} });
    await expect(resolveWorkflowDeployConfig({ ...args, db })).rejects.toThrow(/misconfigured/);
  });
});
