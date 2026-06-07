import { describe, expect, it, mock } from 'bun:test';
import {
  repairTenantAgentCredentials,
  repairUserAgentCredentials,
  type RepairDB,
} from './agent-credential-repair';

type AgentRow = {
  id: string;
  credentialRequirements: unknown;
  modelConfig: unknown;
};

type CredRow = { id: string; name: string; providerId: string };
type ProvRow = { id: string; name: string; plugin?: string; metadata: unknown };

function makeDB(opts: {
  principals?: Array<{ tenantId: string }>;
  credentials?: CredRow[];
  providers?: ProvRow[];
  agents?: AgentRow[];
}): { db: RepairDB; updates: Array<{ values: Record<string, unknown> }> } {
  const updates: Array<{ values: Record<string, unknown> }> = [];
  const providers = opts.providers ?? [];
  const db: RepairDB = {
    query: {
      principal: { findMany: mock(() => Promise.resolve(opts.principals ?? [])) },
      credential: { findMany: mock(() => Promise.resolve(opts.credentials ?? [])) },
      provider: {
        findFirst: mock(() => {
          // The mock can't read the drizzle condition; tests use a single provider.
          return Promise.resolve(providers[0]);
        }),
      },
      agent: { findMany: mock(() => Promise.resolve(opts.agents ?? [])) },
    },
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => ({
        where: mock(() => {
          updates.push({ values });
          return Promise.resolve([]);
        }),
      })),
    })),
  };
  return { db, updates };
}

describe('repairTenantAgentCredentials', () => {
  it('binds an agent with no requirements to the sole tenant credential and sets the model', async () => {
    const { db, updates } = makeDB({
      credentials: [{ id: 'cred-1', name: 'Myra LLM', providerId: 'prov-1' }],
      providers: [{ id: 'prov-1', name: 'openai-compatible', metadata: { model: 'gpt-5.5' } }],
      agents: [{ id: 'agent-1', credentialRequirements: null, modelConfig: null }],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');

    expect(updates).toHaveLength(1);
    const v = updates[0]!.values;
    expect(v.credentialRequirements).toEqual([
      { source: 'tenant', name: 'Myra LLM', providerName: 'openai-compatible' },
    ]);
    expect(v.modelConfig).toEqual({ defaultModel: 'gpt-5.5' });
  });

  it('fills providerName on an existing tenant requirement that is missing it', async () => {
    const { db, updates } = makeDB({
      credentials: [{ id: 'cred-1', name: 'Myra LLM', providerId: 'prov-1' }],
      providers: [{ id: 'prov-1', name: 'anthropic', metadata: { model: 'claude-opus-4-8' } }],
      agents: [
        {
          id: 'agent-1',
          credentialRequirements: [{ source: 'tenant', name: 'Myra LLM' }],
          modelConfig: null,
        },
      ],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');

    expect(updates).toHaveLength(1);
    expect(updates[0]!.values.credentialRequirements).toEqual([
      { source: 'tenant', name: 'Myra LLM', providerName: 'anthropic' },
    ]);
    expect(updates[0]!.values.modelConfig).toEqual({ defaultModel: 'claude-opus-4-8' });
  });

  it('sets the model for an existing tenant requirement that already has providerName', async () => {
    const { db, updates } = makeDB({
      credentials: [{ id: 'cred-1', name: 'Myra LLM', providerId: 'prov-1' }],
      providers: [{ id: 'prov-1', name: 'openai-compatible', metadata: { model: 'gpt-4o-mini' } }],
      agents: [
        {
          id: 'agent-1',
          credentialRequirements: [
            { source: 'tenant', name: 'Myra LLM', providerName: 'openai-compatible' },
          ],
          modelConfig: null,
        },
      ],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');

    expect(updates).toHaveLength(1);
    expect(updates[0]!.values.credentialRequirements).toEqual([
      { source: 'tenant', name: 'Myra LLM', providerName: 'openai-compatible' },
    ]);
    expect(updates[0]!.values.modelConfig).toEqual({ defaultModel: 'gpt-4o-mini' });
  });

  it('does not overwrite a model the agent already has', async () => {
    const { db, updates } = makeDB({
      credentials: [{ id: 'cred-1', name: 'Myra LLM', providerId: 'prov-1' }],
      providers: [{ id: 'prov-1', name: 'anthropic', metadata: { model: 'claude-opus-4-8' } }],
      agents: [
        {
          id: 'agent-1',
          credentialRequirements: [
            { source: 'tenant', name: 'Myra LLM', providerName: 'anthropic' },
          ],
          modelConfig: { defaultModel: 'claude-sonnet-4-6' },
        },
      ],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');

    // Fully configured + custom model — nothing to change.
    expect(updates).toHaveLength(0);
  });

  it('is a no-op when the tenant has no active credentials', async () => {
    const { db, updates } = makeDB({
      credentials: [],
      agents: [{ id: 'agent-1', credentialRequirements: null, modelConfig: null }],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');
    expect(updates).toHaveLength(0);
  });

  it('does not bind an unconfigured agent when the tenant has multiple credentials', async () => {
    const { db, updates } = makeDB({
      credentials: [
        { id: 'cred-1', name: 'Myra LLM', providerId: 'prov-1' },
        { id: 'cred-2', name: 'Other LLM', providerId: 'prov-1' },
      ],
      providers: [{ id: 'prov-1', name: 'anthropic', metadata: { model: 'claude-opus-4-8' } }],
      agents: [{ id: 'agent-1', credentialRequirements: null, modelConfig: null }],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');
    expect(updates).toHaveLength(0);
  });

  it('does not bind an unconfigured agent to a sole non-inference credential', async () => {
    const { db, updates } = makeDB({
      credentials: [{ id: 'cred-1', name: 'Granola Key', providerId: 'prov-1' }],
      providers: [{ id: 'prov-1', name: 'granola', plugin: 'granola', metadata: {} }],
      agents: [{ id: 'agent-1', credentialRequirements: null, modelConfig: null }],
    });

    await repairTenantAgentCredentials(db, 'tenant-1');
    expect(updates).toHaveLength(0);
  });
});

describe('repairUserAgentCredentials', () => {
  it('repairs every distinct tenant where the user is a principal', async () => {
    const principalFindMany = mock(() =>
      Promise.resolve([
        { tenantId: 'tenant-a' },
        { tenantId: 'tenant-b' },
        { tenantId: 'tenant-a' },
      ])
    );
    const credentialFindMany = mock(() => Promise.resolve([]));
    const db: RepairDB = {
      query: {
        principal: { findMany: principalFindMany },
        credential: { findMany: credentialFindMany },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findMany: mock(() => Promise.resolve([])) },
      },
      update: mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve([])) })) })),
    };

    await repairUserAgentCredentials(db, 'user-1');

    // tenant-a deduped: two distinct tenants -> two credential lookups.
    expect(credentialFindMany).toHaveBeenCalledTimes(2);
  });
});
