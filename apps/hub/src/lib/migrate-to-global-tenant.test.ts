import { describe, expect, it, mock } from 'bun:test';
import { migrateUserToGlobalTenant, type MigrationDeps } from './migrate-to-global-tenant';

// Inject stub provisioning helpers (real ones have their own tests). Injection
// avoids mock.module-ing a first-party module that other suites use for real —
// Bun module mocks persist across files in one process.
const ensureGlobalMemberMock = mock(() =>
  Promise.resolve({ tenantId: 'tnt_global', principalId: 'prn_new' })
);
const provisionMemberInstancesMock = mock(() =>
  Promise.resolve([{ templateKey: 'myra', instanceId: 'ins_global_myra' }])
);
const deps = {
  ensureGlobalMember: ensureGlobalMemberMock,
  provisionMemberInstances: provisionMemberInstancesMock,
} as unknown as MigrationDeps;

type FindManyMap = {
  tenant?: unknown[];
  principal?: unknown[];
  agentInstance?: unknown[];
  workflowRun?: unknown[];
  artifact?: unknown[];
  artifactVersion?: unknown[];
  enabledWorkflow?: unknown[];
};

function makeDb(opts: {
  personalTenant?: { id: string; slug: string } | undefined;
  oldPrincipal?: { id: string } | undefined;
  findMany?: FindManyMap;
}) {
  const fm = opts.findMany ?? {};
  const updateCalls: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  let base: any;
  const update = mock((table: unknown) => {
    updateCalls.push(String((table as { _?: { name?: string } })?._?.name ?? 'unknown'));
    return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
  });
  base = {
    query: {
      tenant: {
        findFirst: mock(() => Promise.resolve(opts.personalTenant)),
        findMany: mock(() => Promise.resolve(fm.tenant ?? [])),
      },
      principal: {
        findFirst: mock(() => Promise.resolve(opts.oldPrincipal)),
        findMany: mock(() => Promise.resolve(fm.principal ?? [])),
      },
      agentInstance: { findMany: mock(() => Promise.resolve(fm.agentInstance ?? [])) },
      workflowRun: { findMany: mock(() => Promise.resolve(fm.workflowRun ?? [])) },
      artifact: { findMany: mock(() => Promise.resolve(fm.artifact ?? [])) },
      artifactVersion: { findMany: mock(() => Promise.resolve(fm.artifactVersion ?? [])) },
      enabledWorkflow: { findMany: mock(() => Promise.resolve(fm.enabledWorkflow ?? [])) },
      user: { findMany: mock(() => Promise.resolve([])) },
    },
    update,
    insert: mock(() => ({ values: mock(() => ({ returning: mock(() => Promise.resolve([])) })) })),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    transaction: mock((fn: (tx: any) => Promise<unknown>) => fn(base)),
  };
  return { db: base, updateCalls, update };
}

describe('migrateUserToGlobalTenant', () => {
  const COMMON = { globalTenantId: 'tnt_global', globalTenantDomain: 'acme.example.com' };

  it('dry run writes nothing and reports counts', async () => {
    ensureGlobalMemberMock.mockClear();
    provisionMemberInstancesMock.mockClear();
    const { db, update } = makeDb({
      personalTenant: { id: 'tnt_personal', slug: 'user-alice' },
      oldPrincipal: { id: 'prn_old' },
      findMany: {
        workflowRun: [{ id: 'r1' }, { id: 'r2' }],
        artifact: [{ id: 'a1' }],
        artifactVersion: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }],
        enabledWorkflow: [{ id: 'ew1' }, { id: 'ew2' }],
        agentInstance: [{ id: 'ins_old' }],
        tenant: [{ id: 'tnt_wb' }],
        principal: [{ tenantId: 'tnt_personal' }, { tenantId: 'tnt_wb' }],
      },
    });

    const res = await migrateUserToGlobalTenant(
      db as never,
      { userId: 'alice', ...COMMON, dryRun: true },
      deps
    );

    expect(res.workflowRunsReKeyed).toBe(2);
    expect(res.artifactsReKeyed).toBe(1);
    expect(res.artifactVersionsReKeyed).toBe(3);
    expect(res.enabledWorkflowsReKeyed).toBe(2);
    expect(res.oldMyraInstancesStopped).toBe(1);
    expect(res.workbenchesReparented).toBe(1);
    // No writes in dry run.
    expect(update).not.toHaveBeenCalled();
    expect(ensureGlobalMemberMock).not.toHaveBeenCalled();
    expect(provisionMemberInstancesMock).not.toHaveBeenCalled();
  });

  it('live run provisions the global Myra and re-keys data', async () => {
    ensureGlobalMemberMock.mockClear();
    provisionMemberInstancesMock.mockClear();
    const { db, update } = makeDb({
      personalTenant: { id: 'tnt_personal', slug: 'user-alice' },
      oldPrincipal: { id: 'prn_old' },
      findMany: {
        workflowRun: [{ id: 'r1' }],
        artifact: [{ id: 'a1' }],
        artifactVersion: [{ id: 'v1' }],
        enabledWorkflow: [{ id: 'ew1' }],
        agentInstance: [{ id: 'ins_old' }],
        tenant: [{ id: 'tnt_wb' }],
        principal: [{ tenantId: 'tnt_wb' }],
      },
    });

    const res = await migrateUserToGlobalTenant(
      db as never,
      { userId: 'alice', ...COMMON, dryRun: false },
      deps
    );

    expect(ensureGlobalMemberMock).toHaveBeenCalledTimes(1);
    expect(provisionMemberInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.newPrincipalId).toBe('prn_new');
    expect(res.globalMyraInstanceId).toBe('ins_global_myra');
    // reparent + workflowRun + artifact + artifactVersion + enabledWorkflow + Myra stop = 6.
    expect(update).toHaveBeenCalledTimes(6);
  });

  it('re-run is a no-op for already-migrated data (zero re-key updates)', async () => {
    ensureGlobalMemberMock.mockClear();
    provisionMemberInstancesMock.mockClear();
    // oldPrincipal exists but all its rows were already re-keyed away → counts 0,
    // no workbenches left to reparent, no old Myra instances running.
    const { db, update } = makeDb({
      personalTenant: { id: 'tnt_personal', slug: 'user-alice' },
      oldPrincipal: { id: 'prn_old' },
      findMany: { principal: [{ tenantId: 'tnt_personal' }] },
    });

    await migrateUserToGlobalTenant(
      db as never,
      { userId: 'alice', ...COMMON, dryRun: false },
      deps
    );

    // ensureGlobalMember + provisionMemberInstances still run (idempotent), but no
    // re-key/reparent/stop UPDATE is issued.
    expect(update).not.toHaveBeenCalled();
  });
});
