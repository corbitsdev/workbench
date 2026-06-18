import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';

mock.module('../services/workflow-orchestration', () => ({
  getRequestedUserContext: mock(() =>
    Promise.resolve({ context: { tenantId: 'tenant-1', principalId: 'prn-1' }, forbidden: false })
  ),
  getUserContext: mock(() => Promise.resolve({ tenantId: 'tenant-1', principalId: 'prn-1' })),
}));

mock.module('../services/skill-library', () => ({
  listSkills: mock(() => Promise.resolve([])),
  getSkillDetail: mock(() => Promise.resolve(null)),
  getSkillVersionPreview: mock(() => Promise.resolve(null)),
  createSkillVersionFromBundle: mock(() =>
    Promise.resolve({ id: 'skill-1', name: 'Test Skill', latestVersionId: 'sv-1' })
  ),
  filesFromZip: mock(() => Promise.resolve([])),
  SkillLibraryError: class SkillLibraryError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

import { createSkillsRouter } from './skills';

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockDb(overrides: Record<string, any> = {}): any {
  return {
    query: {
      skillVersion: {
        findFirst: mock(() => Promise.resolve(null)),
        findMany: mock(() => Promise.resolve([])),
      },
      ...overrides.query,
    },
    delete: mock(() => ({
      where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
    })),
    ...overrides,
  };
}

function makeAssetService(
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  overrides: Partial<Record<string, any>> = {}
) {
  return {
    createAsset: mock(() => Promise.reject(new Error('not implemented'))),
    populateAsset: mock(() => Promise.reject(new Error('not implemented'))),
    attachAsset: mock(() =>
      Promise.resolve({
        id: 'aa-1',
        agentId: 'agent-1',
        assetId: 'asset-1',
        ref: 'refs/heads/main',
      })
    ),
    listAgentAssets: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

function buildApp(
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  db: any,
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  assetService: any,
  userId = 'user-1'
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  parent.route('/', createSkillsRouter(db, assetService, {} as never));
  return parent;
}

describe('POST /agents/:agentId/skills/:skillId', () => {
  it('returns 404 when the skill version is not found', async () => {
    const db = makeMockDb();
    db.query.skillVersion.findFirst = mock(() => Promise.resolve(null));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/skill-missing?tenantId=tenant-1', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('calls assetService.attachAsset and returns 201 when skill exists', async () => {
    const db = makeMockDb();
    db.query.skillVersion.findFirst = mock(() =>
      Promise.resolve({ assetId: 'asset-abc', version: 3 })
    );
    const assetService = makeAssetService();
    const app = buildApp(db, assetService);
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/skill-1?tenantId=tenant-1', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(201);
    expect(assetService.attachAsset).toHaveBeenCalledTimes(1);
    const [callArgs] = (assetService.attachAsset as ReturnType<typeof mock>).mock.calls[0] as [
      { agentId: string; assetId: string; ref: string },
    ];
    expect(callArgs.agentId).toBe('agent-1');
    expect(callArgs.assetId).toBe('asset-abc');
  });
});

describe('DELETE /agents/:agentId/skills/:skillId', () => {
  it('returns 404 when no versions exist for the skill', async () => {
    const db = makeMockDb();
    db.query.skillVersion.findMany = mock(() => Promise.resolve([]));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/skill-missing?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when skill is not attached to the agent', async () => {
    const db = makeMockDb();
    db.query.skillVersion.findMany = mock(() =>
      Promise.resolve([{ assetId: 'asset-abc', version: 1 }])
    );
    const returning = mock(() => Promise.resolve([]));
    db.delete = mock(() => ({ where: mock(() => ({ returning })) }));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/skill-1?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(404);
  });

  it('deletes all version asset rows and returns 200 when skill is attached', async () => {
    const db = makeMockDb();
    db.query.skillVersion.findMany = mock(() =>
      Promise.resolve([
        { assetId: 'asset-v1', version: 1 },
        { assetId: 'asset-v2', version: 2 },
      ])
    );
    const returning = mock(() => Promise.resolve([{ id: 'aa-1' }]));
    const deleteWhere = mock(() => ({ returning }));
    db.delete = mock(() => ({ where: deleteWhere }));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/skill-1?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});
