import { describe, expect, it, mock } from 'bun:test';
import {
  provisionPersonalTenant,
  provisionMyraInstance,
  provisionUserOnSignup,
  type ProvisioningDB,
} from './tenant-provisioning';

// Build a mock DB that satisfies the ProvisioningDB structural type including
// the transaction contract (immediately calls the callback with itself).
function makeMockDB(overrides: Partial<ProvisioningDB> = {}): ProvisioningDB {
  // eslint-disable-next-line prefer-const
  let base: ProvisioningDB;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const txMock = mock((fn: (tx: ProvisioningDB) => Promise<unknown>) => fn(base)) as any;
  base = {
    transaction: txMock,
    query: {
      tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
      principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      role: { findFirst: mock(() => Promise.resolve(undefined)) },
      grant: { findFirst: mock(() => Promise.resolve(undefined)) },
      agent: { findFirst: mock(() => Promise.resolve(undefined)) },
      agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
    },
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    })),
    ...overrides,
  };
  return base;
}

describe('provisionPersonalTenant', () => {
  it('creates tenant, roles, principal, and grants for a new user', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() =>
          Promise.resolve([
            {
              id: 'tenant-abc',
              slug: 'user-abc',
              name: 'User ABC',
              domain: 'user-abc.localhost',
              parentId: null,
              config: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ])
        ),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await provisionPersonalTenant(db as never, {
      userId: 'user-abc',
      userEmail: 'alice@example.com',
    });
    expect(result.tenantId).toBeDefined();
    expect(insertMock).toHaveBeenCalled();
  });

  it('is idempotent — returns existing tenant if slug already exists', async () => {
    const existingTenant = {
      id: 'tenant-existing',
      slug: 'user-abc',
      name: 'User ABC',
      domain: 'user-abc.localhost',
      parentId: null,
      config: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const existingPrincipal = { id: 'prn-existing' };

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await provisionPersonalTenant(db as never, {
      userId: 'user-abc',
      userEmail: 'alice@example.com',
    });
    expect(result.tenantId).toBe('tenant-existing');
    expect(result.principalId).toBe('prn-existing');
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('provisionMyraInstance', () => {
  const TENANT_ID = 'tenant-abc';
  const TENANT_DOMAIN = 'user-abc.localhost';
  const USER_ID = 'user-abc';

  function makeInsertMockReturningAgent() {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const insertMock: any = mock(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const valuesMock: any = mock((row: any) => {
        // Return a plausible agent row when inserting into agent table
        return {
          returning: mock(() =>
            Promise.resolve([
              {
                id: row.id ?? 'agt-myra',
                tenantId: TENANT_ID,
                name: 'Myra',
                status: 'deployed',
                currentVersion: '1',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ])
          ),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      });
      return { values: valuesMock };
    });
    return insertMock;
  }

  it('creates agent, agentVersion, principal, and agentInstance for a new user', async () => {
    const insertMock = makeInsertMockReturningAgent();

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await provisionMyraInstance(db as never, {
      personalTenantId: TENANT_ID,
      personalTenantDomain: TENANT_DOMAIN,
      userId: USER_ID,
      creatorPrincipalId: 'prn-owner',
    });

    expect(result.paInstanceId).toBeDefined();
    expect(insertMock).toHaveBeenCalled();
  });

  it('is idempotent — returns existing instance if Myra already exists', async () => {
    const existingAgent = {
      id: 'agt-myra-existing',
      tenantId: TENANT_ID,
      name: 'Myra',
      status: 'deployed',
      currentVersion: '1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const existingInstance = {
      id: 'ins-myra-existing',
      agentId: 'agt-myra-existing',
      tenantId: TENANT_ID,
      address: `ins-myra-existing@${TENANT_DOMAIN}`,
      status: 'deployed',
      principalId: 'prn-myra',
      createdAt: new Date(),
      updatedAt: new Date(),
      endedAt: null,
    };

    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(existingAgent)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(existingInstance)) },
      },
      insert: insertMock,
    });

    const result = await provisionMyraInstance(db as never, {
      personalTenantId: TENANT_ID,
      personalTenantDomain: TENANT_DOMAIN,
      userId: USER_ID,
      creatorPrincipalId: 'prn-owner',
    });

    expect(result.paInstanceId).toBe('ins-myra-existing');
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('provisionUserOnSignup', () => {
  it('returns personalTenantId and paInstanceId', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() =>
          Promise.resolve([
            {
              id: 'tenant-abc',
              slug: 'user-abc',
              name: 'User ABC',
              domain: 'user-abc.localhost',
              parentId: null,
              config: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ])
        ),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await provisionUserOnSignup(db as never, {
      userId: 'user-abc',
      userEmail: 'alice@example.com',
    });

    expect(result.personalTenantId).toBeDefined();
    expect(result.paInstanceId).toBeDefined();
  });
});
