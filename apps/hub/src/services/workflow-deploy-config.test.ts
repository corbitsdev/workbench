import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as intxDb from '@intx/db';
import type { HubDb } from '../db';

const source = {
  id: 'src1',
  provider: 'openai-compatible',
  baseURL: 'http://llm',
  apiKey: 'k',
  model: 'deepseek-v4-flash',
};

let outcome: unknown = { ok: true, source };
const resolveOneCredential = mock(async () => outcome);
mock.module('@intx/db', () => ({ ...intxDb, resolveOneCredential }));

const { resolveWorkflowDeployConfig } = await import('./workflow-deploy-config');

afterAll(() => {
  mock.restore();
});

const args = {
  db: {} as HubDb,
  tenantId: 'ten',
  principalId: 'prn',
  deploymentDomain: 'local',
};

describe('resolveWorkflowDeployConfig', () => {
  test('builds a base config carrying the resolved tenant inference source', async () => {
    outcome = { ok: true, source };
    const result = await resolveWorkflowDeployConfig(args);

    expect(result.config.sources).toEqual([source]);
    expect(result.config.defaultSource).toBe('src1');
    expect(result.config.tenantId).toBe('ten');
    expect(result.config.principalId).toBe('prn');
    expect(result.config.agentAddress).toBe(`${result.deploymentId}@local`);
    expect(result.config.agentId).toBe(result.deploymentId);
  });

  test('throws a clear error when the tenant LLM credential is missing', async () => {
    outcome = { ok: false, reason: 'credential_missing' };
    await expect(resolveWorkflowDeployConfig(args)).rejects.toThrow(
      /cannot resolve LLM credential/
    );
  });
});
