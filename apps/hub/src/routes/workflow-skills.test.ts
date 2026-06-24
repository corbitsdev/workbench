import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runRows = new Map<string, { id: string; tenantId: string; principalId: string }>();
const principals = new Map<string, { id: string; tenantId: string; refId: string }>();
const skillAssets = new Map<
  string,
  { id: string; name: string; displayName: string | null } | null
>();
const skillFiles = new Map<string, { path: string; content?: string }[]>();

const getSkillAsset = mock(
  async (_db: unknown, _viewer: unknown, assetId: string) => skillAssets.get(assetId) ?? null
);
const getSkillContent = mock(
  async (_repoStore: unknown, assetId: string) => skillFiles.get(assetId) ?? []
);

mock.module('../services/skill-library', () => ({
  getSkillAsset,
  getSkillContent,
}));

const { createInternalWorkflowSkillsRouter } = await import('./workflow-skills');

function db() {
  return {
    query: {
      workflowRunRecord: {
        findFirst: async ({ where }: { where: unknown }) => {
          void where;
          return runRows.get('run_1') ?? null;
        },
      },
      principal: {
        findFirst: async ({ where }: { where: unknown }) => {
          void where;
          return principals.get('prn_1') ?? null;
        },
      },
    },
  } as never;
}

beforeEach(() => {
  runRows.clear();
  principals.clear();
  skillAssets.clear();
  skillFiles.clear();
  getSkillAsset.mockClear();
  getSkillContent.mockClear();
});

async function post(body: unknown, token = 'tok') {
  const router = createInternalWorkflowSkillsRouter(db(), {} as never, 'tok');
  return router.request('/workflow-skills/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('POST /workflow-skills/resolve', () => {
  test('resolves selected skill IDs for the run owner', async () => {
    runRows.set('run_1', { id: 'run_1', tenantId: 'ten_1', principalId: 'prn_1' });
    principals.set('prn_1', { id: 'prn_1', tenantId: 'ten_1', refId: 'usr_1' });
    skillAssets.set('skill_1', { id: 'skill_1', name: 'hammy', displayName: 'Hammy' });
    skillFiles.set('skill_1', [{ path: 'SKILL.md', content: '---\nname: hammy\n---\nBe human.' }]);

    const res = await post({ tenantId: 'ten_1', runId: 'run_1', skillIds: ['skill_1'] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skills: [{ id: 'skill_1', name: 'hammy', displayName: 'Hammy', content: 'Be human.' }],
    });
    expect(getSkillAsset).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 'ten_1', userId: 'usr_1' },
      'skill_1'
    );
  });

  test('fails closed when a requested skill cannot be resolved', async () => {
    runRows.set('run_1', { id: 'run_1', tenantId: 'ten_1', principalId: 'prn_1' });
    principals.set('prn_1', { id: 'prn_1', tenantId: 'ten_1', refId: 'usr_1' });
    skillAssets.set('missing_skill', null);

    const res = await post({ tenantId: 'ten_1', runId: 'run_1', skillIds: ['missing_skill'] });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'selected skills could not be resolved',
      unresolved: ['missing_skill'],
    });
  });

  test('requires the sidecar bearer token', async () => {
    const res = await post({ tenantId: 'ten_1', runId: 'run_1', skillIds: [] }, 'wrong');
    expect(res.status).toBe(401);
  });
});
