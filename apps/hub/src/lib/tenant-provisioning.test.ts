import { describe, expect, it, mock } from 'bun:test';
import {
  provisionPersonalTenant,
  ensureWorkbenchPrincipal,
  ensureWorkbenchTenant,
  seedDeliverGrant,
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
    // No insert should happen for the tenant itself
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('ensureWorkbenchTenant', () => {
  it('creates the workbench tenant if it does not exist', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() =>
          Promise.resolve([
            {
              id: 'tenant-workbench',
              slug: 'gtm-workbench',
              name: 'GTM Workbench',
              domain: 'gtm-workbench.localhost',
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

    const result = await ensureWorkbenchTenant(db as never, 'gtm-workbench');
    expect(result.tenantId).toBeDefined();
    expect(insertMock).toHaveBeenCalled();
  });

  it('returns the existing tenant ID if it already exists', async () => {
    const existingTenant = {
      id: 'tenant-workbench-existing',
      slug: 'gtm-workbench',
      name: 'GTM Workbench',
      domain: 'gtm-workbench.localhost',
      parentId: null,
      config: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insertMock = mock(() => ({
      values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
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

    const result = await ensureWorkbenchTenant(db as never, 'gtm-workbench');
    expect(result.tenantId).toBe('tenant-workbench-existing');
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('ensureWorkbenchPrincipal', () => {
  it('creates a principal for the user in the workbench tenant if not present', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{ id: 'principal-abc' }])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve({ id: 'role-member-id' })) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureWorkbenchPrincipal(db as never, {
      userId: 'user-abc',
      workbenchTenantId: 'tenant-workbench',
    });

    expect(result.principalId).toBeDefined();
    expect(insertMock).toHaveBeenCalled();
  });

  it('returns existing principal ID if user is already a member', async () => {
    const existingPrincipal = { id: 'principal-existing' };

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(existingPrincipal)) },
        role: { findFirst: mock(() => Promise.resolve({ id: 'role-member-id' })) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });

    const result = await ensureWorkbenchPrincipal(db as never, {
      userId: 'user-abc',
      workbenchTenantId: 'tenant-workbench',
    });

    expect(result.principalId).toBe('principal-existing');
  });
});

describe('seedDeliverGrant', () => {
  it('inserts a deliver grant if not already present', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve({ id: 'role-owner-id' })) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    await seedDeliverGrant(db as never, {
      personalTenantId: 'tenant-personal',
      workbenchTenantId: 'tenant-workbench',
    });

    expect(insertMock).toHaveBeenCalled();
  });

  it('skips inserting grant if already present', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));

    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve({ id: 'role-owner-id' })) },
        grant: { findFirst: mock(() => Promise.resolve({ id: 'grant-existing' })) },
      },
      insert: insertMock,
    });

    await seedDeliverGrant(db as never, {
      personalTenantId: 'tenant-personal',
      workbenchTenantId: 'tenant-workbench',
    });

    expect(insertMock).not.toHaveBeenCalled();
  });
});
