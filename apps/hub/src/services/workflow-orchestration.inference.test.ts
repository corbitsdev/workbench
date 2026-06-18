import { describe, expect, it, mock, beforeEach } from 'bun:test';
import * as intxDb from '@intx/db';
import type { HubDb } from '../db';
import { providerMetadataModel, resolveCredentialInferenceSource } from './workflow-orchestration';

const resolveCredentialById = mock<
  () => Promise<{
    id: string;
    providerId: string;
    secret: string;
    tenantId: string;
    principalId: null;
    name: string;
  } | null>
>(async () => ({
  id: 'cred-zen',
  providerId: 'prov-zen',
  secret: 'sk-zen',
  tenantId: 'tenant-1',
  principalId: null,
  name: 'opencode-zen',
}));

const providerFindFirst = mock<
  () => Promise<{
    id: string;
    plugin: string;
    name: string;
    metadata: Record<string, unknown>;
  } | null>
>(async () => ({
  id: 'prov-zen',
  plugin: 'openai-compatible',
  name: 'openai-compatible',
  metadata: { baseURL: 'https://opencode.ai/zen/v1', model: 'claude-sonnet-4' },
}));

mock.module('@intx/db', () => ({
  ...intxDb,
  resolveCredentialById,
}));

function createDb(): HubDb {
  return {
    query: {
      provider: {
        findFirst: providerFindFirst,
      },
    },
  } as unknown as HubDb;
}

beforeEach(() => {
  resolveCredentialById.mockClear();
  providerFindFirst.mockClear();
});

describe('providerMetadataModel', () => {
  it('returns trimmed model strings from provider metadata', () => {
    expect(providerMetadataModel({ model: '  claude-sonnet-4  ' })).toBe('claude-sonnet-4');
  });

  it('returns undefined for empty or non-string model values', () => {
    expect(providerMetadataModel({ model: '' })).toBeUndefined();
    expect(providerMetadataModel({ model: '   ' })).toBeUndefined();
    expect(providerMetadataModel({ model: 42 })).toBeUndefined();
    expect(providerMetadataModel(null)).toBeUndefined();
  });
});

describe('resolveCredentialInferenceSource', () => {
  it('uses the provider metadata model when no override is given', async () => {
    const source = await resolveCredentialInferenceSource(createDb(), 'tenant-1', 'cred-zen');
    expect(source).toEqual({
      id: 'openai-compatible:claude-sonnet-4',
      provider: 'openai-compatible',
      baseURL: 'https://opencode.ai/zen/v1',
      apiKey: 'sk-zen',
      model: 'claude-sonnet-4',
    });
  });

  it('prefers an explicit model override from the workflow option', async () => {
    const source = await resolveCredentialInferenceSource(
      createDb(),
      'tenant-1',
      'cred-zen',
      'gpt-4.1-mini'
    );
    expect(source?.model).toBe('gpt-4.1-mini');
    expect(source?.id).toBe('openai-compatible:gpt-4.1-mini');
  });

  it('returns null when the provider has no model configured', async () => {
    providerFindFirst.mockResolvedValueOnce({
      id: 'prov-zen',
      plugin: 'openai-compatible',
      name: 'openai-compatible',
      metadata: { baseURL: 'https://opencode.ai/zen/v1' },
    });
    const source = await resolveCredentialInferenceSource(createDb(), 'tenant-1', 'cred-zen');
    expect(source).toBeNull();
  });

  it('returns null when the credential cannot be resolved', async () => {
    resolveCredentialById.mockResolvedValueOnce(null);
    const source = await resolveCredentialInferenceSource(createDb(), 'tenant-1', 'missing');
    expect(source).toBeNull();
  });
});
