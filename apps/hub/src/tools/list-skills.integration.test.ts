import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodefs from 'node:fs';
import git from 'isomorphic-git';

// Integration test: the handler runs against the REAL skill-library functions
// (listSkills, getSkillAsset, getSkillContent) and a REAL on-disk asset git
// repo. Only the `@intx/db` ancestor-chain helper is mocked (the tenancy
// boundary) and the drizzle query builder is a hand-rolled fake that serves the
// canned asset+access rows. The point is to exercise the real `isSkillVisible`
// rule across the seam — a private skill owned by another user must be excluded
// from list and denied on load — rather than re-assert a mocked decision.

const ancestorTenantIds = ['ten_child', 'ten_parent'];
const realDb = await import('@intx/db');
mock.module('@intx/db', () => ({
  ...realDb,
  getAncestorChain: async () => ancestorTenantIds,
}));

const { createSkillTools } = await import('./list-skills');

type AssetRow = {
  id: string;
  name: string;
  displayName: string | null;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
  scope: 'private' | 'tenant' | null;
  ownerUserId: string | null;
  ownerName: string | null;
};

let assetRows: AssetRow[] = [];

// Minimal drizzle-shaped fake: listSkills runs select→from→leftJoin*→where→orderBy
// (awaited), getSkillAsset runs select→from→leftJoin*→where→limit. Both resolve
// to the canned rows; the real skill-library code then applies isSkillVisible.
function fakeDb() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(assetRows),
    limit: () => Promise.resolve(assetRows),
  };
  return {
    select: () => chain,
    query: {
      principal: {
        findFirst: async () => ({ id: 'prn_1', tenantId: 'ten_child', refId: 'usr_owner' }),
      },
    },
  } as never;
}

const SKILL_REF = 'refs/heads/main';
let repoRoot: string;

async function writeSkillRepo(
  assetId: string,
  assetName: string,
  files: Record<string, string>
): Promise<void> {
  const dir = join(repoRoot, assetId);
  await nodefs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs: nodefs, dir, defaultBranch: 'main' });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, `${assetName}/${rel}`);
    await nodefs.promises.mkdir(join(full, '..'), { recursive: true });
    await nodefs.promises.writeFile(full, content);
    await git.add({ fs: nodefs, dir, filepath: `${assetName}/${rel}` });
  }
  await git.commit({
    fs: nodefs,
    dir,
    ref: SKILL_REF,
    message: 'Add skill',
    author: { name: 'test', email: 'test@test', timestamp: 1, timezoneOffset: 0 },
  });
}

function repoStore() {
  return {
    getRepoDir: ({ id }: { kind: string; id: string }) => join(repoRoot, id),
  } as never;
}

function tools() {
  return createSkillTools({
    db: fakeDb(),
    repoStore: repoStore(),
    tenantId: 'ten_child',
    principalId: 'prn_1',
  });
}

function handler(name: string) {
  const t = tools().find((x) => x.definition.name === name);
  if (!t || t.kind !== 'string') throw new Error(`missing ${name}`);
  return t.handler;
}

const NOW = new Date('2026-01-01T00:00:00Z');

// a1: tenant-scoped in a parent tenant → visible to anyone in the chain.
const TENANT_SKILL: AssetRow = {
  id: 'a1',
  name: 'deck',
  displayName: 'Deck',
  tenantId: 'ten_parent',
  createdAt: NOW,
  updatedAt: NOW,
  scope: 'tenant',
  ownerUserId: 'usr_other',
  ownerName: 'Other',
};

// a2: private, owned by a DIFFERENT user (not the viewer) → invisible.
const PRIVATE_OTHER_SKILL: AssetRow = {
  id: 'a2',
  name: 'secret',
  displayName: 'Secret',
  tenantId: 'ten_child',
  createdAt: NOW,
  updatedAt: NOW,
  scope: 'private',
  ownerUserId: 'usr_other',
  ownerName: 'Other',
};

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'skill-int-'));
  assetRows = [TENANT_SKILL, PRIVATE_OTHER_SKILL];
});

afterAll(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

describe('skill tools over the real skill-library seam', () => {
  test('list_skills excludes a private skill owned by another user', async () => {
    const result = await handler('list_skills')({}, new AbortController().signal);
    const ids = JSON.parse(result).skills.map((s: { id: string }) => s.id);
    expect(ids).toEqual(['a1']);
    expect(ids).not.toContain('a2');
  });

  test('search_skills also excludes the invisible private skill', async () => {
    const result = await handler('search_skills')(
      { query: 'secret' },
      new AbortController().signal
    );
    expect(JSON.parse(result).skills).toEqual([]);
  });

  test('load_skill returns body + siblings for a visible skill', async () => {
    // getSkillAsset is filtered by id in the real query; the fake ignores the
    // where clause and returns rows[0], so scope it to the asset under test.
    assetRows = [TENANT_SKILL];
    await writeSkillRepo('a1', 'deck', {
      'SKILL.md': '---\nname: deck\ndescription: "x"\n---\nBuild the deck.',
      'notes/tips.md': 'tip one',
    });
    const result = await handler('load_skill')({ id: 'a1' }, new AbortController().signal);
    const parsed = JSON.parse(result);
    expect(parsed.id).toBe('a1');
    expect(parsed.body).toBe('Build the deck.');
    expect(parsed.files).toEqual([{ path: 'notes/tips.md', content: 'tip one' }]);
  });

  test('load_skill denies a private skill owned by another user', async () => {
    assetRows = [PRIVATE_OTHER_SKILL];
    await writeSkillRepo('a2', 'secret', { 'SKILL.md': '---\nname: secret\n---\nhidden' });
    await expect(handler('load_skill')({ id: 'a2' }, new AbortController().signal)).rejects.toThrow(
      'Skill not found: a2'
    );
  });
});
