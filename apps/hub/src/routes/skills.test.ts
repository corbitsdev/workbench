import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';

mock.module('../services/workflow-orchestration', () => ({
  getRequestedUserContext: mock(() =>
    Promise.resolve({ context: { tenantId: 'tenant-1', principalId: 'prn-1' }, forbidden: false })
  ),
  getUserContext: mock(() => Promise.resolve({ tenantId: 'tenant-1', principalId: 'prn-1' })),
}));

const mockCreateSkill = mock(() =>
  Promise.resolve({
    id: 'ast-1',
    name: 'test-skill',
    displayName: 'Test Skill',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
  })
);

const mockUpdateSkill = mock(() =>
  Promise.resolve({
    id: 'ast-1',
    name: 'test-skill',
    displayName: 'Test Skill',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T01:00:00.000Z',
  })
);

const mockListSkills = mock(() =>
  Promise.resolve([
    {
      id: 'ast-1',
      name: 'test-skill',
      displayName: 'Test Skill',
      createdAt: '2026-06-17T00:00:00.000Z',
      updatedAt: '2026-06-17T00:00:00.000Z',
    },
  ])
);

const mockGetSkillAsset = mock(() => Promise.resolve(null));
const mockGetSkillContent = mock(() => Promise.resolve([{ path: 'SKILL.md', content: '# Hi' }]));

const mockListSkillVersions = mock(() =>
  Promise.resolve([
    {
      sha: 'abc1234def',
      shortSha: 'abc1234',
      version: 2,
      message: 'Edit',
      authorName: 'Mae',
      createdAt: '2026-06-17T00:00:00.000Z',
    },
  ])
);

const mockRestoreSkillVersion = mock(() =>
  Promise.resolve({
    id: 'ast-1',
    name: 'test-skill',
    displayName: 'Test Skill',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T02:00:00.000Z',
    scope: 'tenant',
    accessTenantId: 'tenant-1',
    ownerUserId: 'user-1',
  })
);

mock.module('../services/skill-library', () => ({
  listSkills: mockListSkills,
  getSkillAsset: mockGetSkillAsset,
  getSkillContent: mockGetSkillContent,
  createSkill: mockCreateSkill,
  updateSkill: mockUpdateSkill,
  listSkillVersions: mockListSkillVersions,
  restoreSkillVersion: mockRestoreSkillVersion,
  listShareTargets: mock(() =>
    Promise.resolve([
      { tenantId: 'tenant-1', name: 'Acme Org' },
      { tenantId: 'root-1', name: 'Acme Root' },
    ])
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
      asset: {
        findFirst: mock(() => Promise.resolve(null)),
      },
      ...overrides.query,
    },
    delete: mock(() => ({
      where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
    })),
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeAssetService(overrides: Partial<Record<string, any>> = {}) {
  return {
    createAsset: mock(() => Promise.reject(new Error('not implemented'))),
    populateAsset: mock(() => Promise.reject(new Error('not implemented'))),
    attachAsset: mock(() =>
      Promise.resolve({
        id: 'aa-1',
        agentId: 'agent-1',
        assetId: 'ast-1',
        ref: 'refs/heads/main',
      })
    ),
    listAgentAssets: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function buildApp(db: any, assetService: any, userId = 'user-1') {
  const parent = new Hono<{ Variables: { userId: string; userName: string } }>();
  parent.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('userName', 'Test User');
    await next();
  });
  parent.route('/', createSkillsRouter(db, assetService, {} as never));
  return parent;
}

describe('GET /skills', () => {
  it('returns the skill list', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(new Request('http://localhost/skills?tenantId=tenant-1'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { skills: unknown[] };
    expect(Array.isArray(json.skills)).toBe(true);
    expect(json.skills.length).toBe(1);
  });
});

describe('GET /skills/share-targets', () => {
  it('returns the shareable tenants for the caller', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/share-targets?tenantId=tenant-1')
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { targets: { tenantId: string; name: string }[] };
    expect(json.targets.map((t) => t.tenantId)).toEqual(['tenant-1', 'root-1']);
  });
});

describe('GET /skills/:assetId', () => {
  it('returns 404 when skill is not found', async () => {
    mockGetSkillAsset.mockImplementation(() => Promise.resolve(null));
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/ast-missing?tenantId=tenant-1')
    );
    expect(res.status).toBe(404);
  });

  it('returns skill and files when found', async () => {
    mockGetSkillAsset.mockImplementation(() =>
      Promise.resolve({
        id: 'ast-1',
        name: 'test-skill',
        displayName: 'Test Skill',
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      })
    );
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(new Request('http://localhost/skills/ast-1?tenantId=tenant-1'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { skill: { id: string }; files: unknown[] };
    expect(json.skill.id).toBe('ast-1');
    expect(Array.isArray(json.files)).toBe(true);
    // restore
    mockGetSkillAsset.mockImplementation(() => Promise.resolve(null));
  });
});

describe('POST /skills (JSON create)', () => {
  it('returns 201 with the created skill', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Test Skill', text: '# My skill' }),
      })
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { skill: { id: string } };
    expect(json.skill.id).toBe('ast-1');
    expect(mockCreateSkill).toHaveBeenCalledTimes(1);
  });

  it('forwards the chosen access scope and owning user to createSkill', async () => {
    mockCreateSkill.mockClear();
    const app = buildApp(makeMockDb(), makeAssetService());
    await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Private Skill', text: '# secret', scope: 'private' }),
      })
    );
    const arg = mockCreateSkill.mock.calls[0]?.[3] as { scope: string; ownerUserId: string };
    expect(arg.scope).toBe('private');
    expect(arg.ownerUserId).toBe('user-1');
  });

  it('defaults an unknown scope to tenant-wide', async () => {
    mockCreateSkill.mockClear();
    const app = buildApp(makeMockDb(), makeAssetService());
    await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Open Skill', text: '# open', scope: 'nonsense' }),
      })
    );
    const arg = mockCreateSkill.mock.calls[0]?.[3] as { scope: string };
    expect(arg.scope).toBe('tenant');
  });
});

describe('GET /skills/:assetId/versions', () => {
  it('returns version history for a visible skill', async () => {
    mockGetSkillAsset.mockImplementation(() =>
      Promise.resolve({
        id: 'ast-1',
        name: 'test-skill',
        displayName: 'Test Skill',
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      })
    );
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/ast-1/versions?tenantId=tenant-1')
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { versions: { shortSha: string }[] };
    expect(json.versions[0]?.shortSha).toBe('abc1234');
    mockGetSkillAsset.mockImplementation(() => Promise.resolve(null));
  });

  it('returns 404 when the skill is not visible', async () => {
    mockGetSkillAsset.mockImplementation(() => Promise.resolve(null));
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/ast-x/versions?tenantId=tenant-1')
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /skills/:assetId/restore', () => {
  it('restores a version and returns the refreshed skill', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/ast-1/restore?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: 'abc1234def' }),
      })
    );
    expect(res.status).toBe(200);
    expect(mockRestoreSkillVersion).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when sha is missing', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills/ast-1/restore?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '# My skill' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is missing', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My Skill' }),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /skills (JSON update)', () => {
  it('calls updateSkill and returns 200 when assetId is present', async () => {
    const app = buildApp(makeMockDb(), makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/skills?tenantId=tenant-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: 'ast-1', text: '# Updated' }),
      })
    );
    expect(res.status).toBe(200);
    expect(mockUpdateSkill).toHaveBeenCalledTimes(1);
  });
});

describe('POST /agents/:agentId/skills/:assetId', () => {
  it('returns 404 when the skill asset is not found', async () => {
    const db = makeMockDb();
    db.query.asset.findFirst = mock(() => Promise.resolve(null));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/ast-missing?tenantId=tenant-1', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBeTruthy();
  });

  it('calls assetService.attachAsset and returns 201 when skill exists', async () => {
    const db = makeMockDb();
    db.query.asset.findFirst = mock(() =>
      Promise.resolve({ id: 'ast-1', name: 'test-skill', tenantId: 'tenant-1', kind: 'skill' })
    );
    const assetService = makeAssetService();
    const app = buildApp(db, assetService);
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/ast-1?tenantId=tenant-1', {
        method: 'POST',
      })
    );
    expect(res.status).toBe(201);
    expect(assetService.attachAsset).toHaveBeenCalledTimes(1);
    const [callArgs] = (assetService.attachAsset as ReturnType<typeof mock>).mock.calls[0] as [
      { agentId: string; assetId: string; ref: string },
    ];
    expect(callArgs.agentId).toBe('agent-1');
    expect(callArgs.assetId).toBe('ast-1');
  });
});

describe('DELETE /agents/:agentId/skills/:assetId', () => {
  it('returns 404 when the skill asset is not found', async () => {
    const db = makeMockDb();
    db.query.asset.findFirst = mock(() => Promise.resolve(null));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/ast-missing?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when skill is not attached to the agent', async () => {
    const db = makeMockDb();
    db.query.asset.findFirst = mock(() =>
      Promise.resolve({ id: 'ast-1', name: 'test-skill', tenantId: 'tenant-1', kind: 'skill' })
    );
    const returning = mock(() => Promise.resolve([]));
    db.delete = mock(() => ({ where: mock(() => ({ returning })) }));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/ast-1?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(404);
  });

  it('deletes from agentAsset and returns 200 when skill is attached', async () => {
    const db = makeMockDb();
    db.query.asset.findFirst = mock(() =>
      Promise.resolve({ id: 'ast-1', name: 'test-skill', tenantId: 'tenant-1', kind: 'skill' })
    );
    const returning = mock(() => Promise.resolve([{ id: 'aa-1' }]));
    const deleteWhere = mock(() => ({ returning }));
    db.delete = mock(() => ({ where: deleteWhere }));
    const app = buildApp(db, makeAssetService());
    const res = await app.fetch(
      new Request('http://localhost/agents/agent-1/skills/ast-1?tenantId=tenant-1', {
        method: 'DELETE',
      })
    );
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});
