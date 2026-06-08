import { describe, expect, it, mock } from 'bun:test';

const GLOBAL_TENANT = { slug: 'acme', name: 'Acme Inc', domain: 'acme.example.com' };

mock.module('../config', () => ({
  getConfig: () => ({
    exa: { apiKey: undefined },
    credentialKeys: [],
    globalTenant: GLOBAL_TENANT,
  }),
  loadConfig: () => ({
    exa: { apiKey: undefined },
    credentialKeys: [],
    globalTenant: GLOBAL_TENANT,
  }),
}));

import {
  provisionMyraInstance,
  provisionWorkbenchTenant,
  seedGlobalTenant,
  ensureGlobalMember,
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
      tenantId: TENANT_ID,
      tenantDomain: TENANT_DOMAIN,
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
      tenantId: TENANT_ID,
      tenantDomain: TENANT_DOMAIN,
      userId: USER_ID,
      creatorPrincipalId: 'prn-owner',
    });

    expect(result.paInstanceId).toBe('ins-myra-existing');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates the Myra agent owned by the given principal (per-user keying)', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        return {
          returning: mock(() => Promise.resolve([{ id: row.id ?? 'agt-myra', name: 'Myra' }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
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

    await provisionMyraInstance(db as never, {
      tenantId: 'tnt_global',
      tenantDomain: 'acme.example.com',
      userId: USER_ID,
      creatorPrincipalId: 'prn_alice',
    });

    const agentRow = inserted.find((r) => r.name === 'Myra');
    expect(agentRow?.creatorPrincipalId).toBe('prn_alice');
    expect(agentRow?.tenantId).toBe('tnt_global');
  });

  it('two owner principals in one tenant get two distinct Myra agents', async () => {
    function makeCapturingDb() {
      const inserted: Array<Record<string, unknown>> = [];
      const insertMock = mock(() => ({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        values: mock((row: any) => {
          inserted.push(row);
          return {
            returning: mock(() => Promise.resolve([{ id: row.id ?? 'agt', name: 'Myra' }])),
            onConflictDoNothing: mock(() => Promise.resolve([])),
          };
        }),
      }));
      // agent.findFirst returns undefined → each owner has no existing Myra.
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
      return { db, inserted };
    }

    const a = makeCapturingDb();
    await provisionMyraInstance(a.db as never, {
      tenantId: 'tnt_global',
      tenantDomain: 'acme.example.com',
      userId: 'alice',
      creatorPrincipalId: 'prn_alice',
    });
    const b = makeCapturingDb();
    await provisionMyraInstance(b.db as never, {
      tenantId: 'tnt_global',
      tenantDomain: 'acme.example.com',
      userId: 'bob',
      creatorPrincipalId: 'prn_bob',
    });

    const aAgent = a.inserted.find((r) => r.name === 'Myra');
    const bAgent = b.inserted.find((r) => r.name === 'Myra');
    expect(aAgent?.creatorPrincipalId).toBe('prn_alice');
    expect(bAgent?.creatorPrincipalId).toBe('prn_bob');
    expect(aAgent?.id).not.toBe(bAgent?.id);
  });
});

describe('provisionWorkbenchTenant', () => {
  it('parents the new workbench under the global tenant (CL-1445)', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    // First tenant lookup is the workbench slug (none); second is the global slug.
    let tenantCall = 0;
    const tenantFind = mock(() => {
      tenantCall += 1;
      return Promise.resolve(tenantCall >= 2 ? { id: 'tnt_global', slug: 'acme' } : undefined);
    });
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        return {
          returning: mock(() => Promise.resolve([{ id: row.id ?? 'tnt_wb' }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: tenantFind },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const res = await provisionWorkbenchTenant(db as never, {
      userId: 'u1',
      name: 'My Workbench',
      slug: 'my-wb',
    });

    expect(res.alreadyExists).toBe(false);
    const tenantRow = inserted.find((r) => r.slug === 'my-wb');
    expect(tenantRow?.parentId).toBe('tnt_global');
  });

  it('throws if the global tenant is not seeded', async () => {
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
    await expect(
      provisionWorkbenchTenant(db as never, { userId: 'u1', name: 'WB', slug: 'wb' })
    ).rejects.toThrow(/not seeded/);
  });
});

describe('seedGlobalTenant', () => {
  // Capture every inserted row so we can classify role and grant rows.
  function makeCapturingDB(opts: {
    tenantFindResults: Array<{ id: string; slug: string } | undefined>;
    insertThrowsOnTenant?: boolean;
  }) {
    const inserted: Array<Record<string, unknown>> = [];
    const tenantFindResults = [...opts.tenantFindResults];
    const tenantFind = mock(() => Promise.resolve(tenantFindResults.shift()));

    let tenantInsertCount = 0;
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        // The tenant row is the only one read back via .returning().
        const isTenant = typeof row.slug === 'string';
        if (isTenant) {
          tenantInsertCount += 1;
          if (opts.insertThrowsOnTenant) {
            throw Object.assign(new Error('duplicate key value violates unique constraint'), {
              code: '23505',
            });
          }
        }
        return {
          returning: mock(() =>
            Promise.resolve(isTenant ? [{ id: 'tnt_global', slug: row.slug }] : [])
          ),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));

    const base = makeMockDB({
      query: {
        tenant: { findFirst: tenantFind },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });
    return {
      db: base,
      inserted,
      get tenantInsertCount() {
        return tenantInsertCount;
      },
    };
  }

  function classify(inserted: Array<Record<string, unknown>>) {
    const roles = inserted.filter((r) => r.isSystem !== undefined);
    const grants = inserted.filter((r) => r.resource !== undefined && r.action !== undefined);
    const roleNameById = new Map<string, string>();
    for (const r of roles) roleNameById.set(r.id as string, r.name as string);
    return { roles, grants, roleNameById };
  }

  it('creates the global tenant from config when it does not exist', async () => {
    const { db, inserted } = makeCapturingDB({ tenantFindResults: [undefined] });
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe('tnt_global');
    const tenantRow = inserted.find((r) => typeof r.slug === 'string');
    expect(tenantRow?.slug).toBe('acme');
    expect(tenantRow?.name).toBe('Acme Inc');
    expect(tenantRow?.domain).toBe('acme.example.com');
    expect(tenantRow?.parentId).toBeNull();
  });

  it('is idempotent — returns the existing tenant without inserting', async () => {
    const { db, inserted } = makeCapturingDB({
      tenantFindResults: [{ id: 'tnt_existing', slug: 'acme' }],
    });
    // Existing tenant has its system roles — the member-role check passes.
    db.query.role.findFirst = mock(() => Promise.resolve({ id: 'rol_member' }));
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe('tnt_existing');
    expect(inserted.length).toBe(0);
  });

  it('fails loud if the existing tenant is missing its system roles', async () => {
    const { db } = makeCapturingDB({
      tenantFindResults: [{ id: 'tnt_existing', slug: 'acme' }],
    });
    // role.findFirst defaults to undefined → member role missing → must throw.
    await expect(seedGlobalTenant(db as never)).rejects.toThrow(/missing its system roles/);
  });

  it('is race-safe — reselects the tenant when the insert hits a unique violation', async () => {
    // First findFirst (pre-check) returns nothing, the insert throws a unique
    // violation, the catch-block reselect finds the row a concurrent boot created.
    const { db } = makeCapturingDB({
      tenantFindResults: [undefined, { id: 'tnt_raced', slug: 'acme' }],
      insertThrowsOnTenant: true,
    });
    const result = await seedGlobalTenant(db as never);
    expect(result.tenantId).toBe('tnt_raced');
  });

  it('seeds owner and admin grants but NOT a member grant', async () => {
    const { db, inserted } = makeCapturingDB({ tenantFindResults: [undefined] });
    await seedGlobalTenant(db as never);
    const { grants, roleNameById } = classify(inserted);

    const memberRoleId = [...roleNameById.entries()].find(([, name]) => name === 'member')?.[0];
    const ownerRoleId = [...roleNameById.entries()].find(([, name]) => name === 'owner')?.[0];
    const adminRoleId = [...roleNameById.entries()].find(([, name]) => name === 'admin')?.[0];
    expect(memberRoleId).toBeDefined();

    // No grant references the member role.
    expect(grants.some((g) => g.roleId === memberRoleId)).toBe(false);

    // Owner keeps *:* and admin keeps read/create/manage.
    expect(
      grants.some((g) => g.roleId === ownerRoleId && g.resource === '*' && g.action === '*')
    ).toBe(true);
    const adminActions = grants
      .filter((g) => g.roleId === adminRoleId)
      .map((g) => g.action)
      .sort();
    expect(adminActions).toEqual(['create', 'manage', 'read']);
  });
});

describe('ensureGlobalMember', () => {
  const GLOBAL = { id: 'tnt_global', slug: 'acme' };
  const MEMBER_ROLE = { id: 'rol_member' };

  it('is idempotent — returns the existing principal without inserting', async () => {
    const insertMock = mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([])),
        onConflictDoNothing: mock(() => Promise.resolve([])),
      })),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: { findFirst: mock(() => Promise.resolve({ id: 'prn_existing' })) },
        role: { findFirst: mock(() => Promise.resolve(MEMBER_ROLE)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureGlobalMember(db as never, {
      userId: 'user-abc',
    });
    expect(result.tenantId).toBe('tnt_global');
    expect(result.principalId).toBe('prn_existing');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates a member principal and assigns the member role for a new user', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        inserted.push(row);
        return {
          returning: mock(() => Promise.resolve([{ id: 'prn_new' }])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(MEMBER_ROLE)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureGlobalMember(db as never, {
      userId: 'user-abc',
    });
    expect(result.tenantId).toBe('tnt_global');

    // The principal is created as a user principal in the global tenant.
    const principalRow = inserted.find((r) => r.kind === 'user');
    expect(principalRow?.refId).toBe('user-abc');
    expect(principalRow?.tenantId).toBe('tnt_global');

    // The role assignment binds it to the member role (not owner/admin).
    const roleAssignment = inserted.find((r) => r.roleId !== undefined);
    expect(roleAssignment?.roleId).toBe('rol_member');
  });

  it('is race-safe — reselects the principal when the insert hits a unique violation', async () => {
    // First call (pre-check) finds nothing; second call (catch-block reselect)
    // finds the row a concurrent signup created.
    let principalFindCalls = 0;
    const principalFind = mock(() => {
      principalFindCalls += 1;
      return Promise.resolve(principalFindCalls >= 2 ? { id: 'prn_raced' } : undefined);
    });
    const insertMock = mock(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      values: mock((row: any) => {
        if (row.kind === 'user') {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          });
        }
        return {
          returning: mock(() => Promise.resolve([])),
          onConflictDoNothing: mock(() => Promise.resolve([])),
        };
      }),
    }));
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(GLOBAL)) },
        principal: { findFirst: principalFind },
        role: { findFirst: mock(() => Promise.resolve(MEMBER_ROLE)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      insert: insertMock,
    });

    const result = await ensureGlobalMember(db as never, {
      userId: 'user-abc',
    });
    expect(result.principalId).toBe('prn_raced');
  });

  it('throws if the global tenant has not been seeded', async () => {
    const db = makeMockDB({
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(undefined)) },
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
        role: { findFirst: mock(() => Promise.resolve(undefined)) },
        grant: { findFirst: mock(() => Promise.resolve(undefined)) },
        agent: { findFirst: mock(() => Promise.resolve(undefined)) },
        agentInstance: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    });
    await expect(ensureGlobalMember(db as never, { userId: 'user-abc' })).rejects.toThrow();
  });
});
