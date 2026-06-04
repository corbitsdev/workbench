import { describe, expect, it, mock } from 'bun:test';
import { provisionPersonalTenant, type ProvisioningDB } from './tenant-provisioning';

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

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(existingTenant)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await provisionPersonalTenant(db as never, {
      userId: 'user-abc',
      userEmail: 'alice@example.com',
    });
    expect(result.tenantId).toBe('tenant-existing');
    expect(insertMock).not.toHaveBeenCalled();
  });
});
