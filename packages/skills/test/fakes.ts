// In-memory double for the one port the registry stands on. It keeps the
// registry suite honest without a live hub or a database: the asset
// double keeps a real per-asset commit list so version history and
// restore are exercised against an append-only log, exactly the shape
// the git-backed store serves.
import type {
  SkillAssetRow,
  SkillAssetStore,
  SkillCommit,
} from "../src/asset-store";
import { isAssetGenesisCommit } from "../src/asset-history";
import { skillMdPath } from "../src/asset-store";

type StoredCommit = {
  readonly commit: SkillCommit;
  readonly files: ReadonlyMap<string, string>;
};

export type FakeSkillAssets = SkillAssetStore & {
  readonly assets: Map<string, SkillAssetRow>;
  /** Makes the next writeSkillMd call throw, simulating a crash between
   * the asset-row write and the SKILL.md write. */
  failNextWriteSkillMd: () => void;
};

/** A tenant's own id, then its parent, then its grandparent, and so on to
 * the root — the same shape `getAncestorChain` returns for real tenants,
 * built here from a flat `tenantId -> parentId` map so tests can lay out
 * a hierarchy without a database. */
export type TenantParents = Readonly<Record<string, string>>;

function ancestorChain(parents: TenantParents, tenantId: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = tenantId;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = parents[current];
  }
  return chain;
}

export function createFakeSkillAssets(
  options: {
    clock?: { now: () => Date };
    tenantParents?: TenantParents;
  } = {},
): FakeSkillAssets {
  const clock = options.clock ?? {
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  const parents = options.tenantParents ?? {};
  const assets = new Map<string, SkillAssetRow>();
  const commits = new Map<string, StoredCommit[]>();
  let nextId = 1;
  let nextSha = 1;
  let failNextWrite = false;

  function tip(assetId: string): StoredCommit | undefined {
    const log = commits.get(assetId);
    return log === undefined ? undefined : log[log.length - 1];
  }

  function ownByName(tenantId: string, name: string): SkillAssetRow | null {
    for (const row of assets.values()) {
      if (row.tenantId === tenantId && row.name === name) return row;
    }
    return null;
  }

  return {
    assets,
    failNextWriteSkillMd() {
      failNextWrite = true;
    },
    async create(input) {
      const key = `${input.tenantId}${input.name}`;
      for (const existing of assets.values()) {
        if (`${existing.tenantId}${existing.name}` === key) {
          throw new Error(`duplicate asset ${input.name}`);
        }
      }
      const now = clock.now();
      const row: SkillAssetRow = {
        id: `asset_${String(nextId++)}`,
        tenantId: input.tenantId,
        name: input.name,
        displayName: input.displayName,
        creatorPrincipalId: input.creatorPrincipalId,
        createdAt: now,
        updatedAt: now,
      };
      assets.set(row.id, row);
      // Mirror the hub's genesis commit so consumer-history filtering is
      // exercised the same way a real `createAsset` → `initRepo` path is.
      commits.set(row.id, [
        {
          commit: {
            commitSha: `commit${String(nextSha++).padStart(4, "0")}`,
            message: "Initialize repository",
            author: "interchange-hub",
            committedAtIso: now.toISOString(),
          },
          files: new Map(),
        },
      ]);
      return row;
    },
    async findByName(tenantId, name) {
      for (const tid of ancestorChain(parents, tenantId)) {
        const row = ownByName(tid, name);
        if (row !== null) return row;
      }
      return null;
    },
    async findOwnByName(tenantId, name) {
      return ownByName(tenantId, name);
    },
    async listForTenant(tenantId) {
      const byName = new Map<string, SkillAssetRow>();
      for (const tid of ancestorChain(parents, tenantId)) {
        for (const row of assets.values()) {
          if (row.tenantId !== tid) continue;
          if (byName.has(row.name)) continue;
          byName.set(row.name, row);
        }
      }
      return [...byName.values()];
    },
    async writeSkillMd(input) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("simulated SKILL.md write failure");
      }
      const log = commits.get(input.assetId);
      if (log === undefined) {
        throw new Error(`no such asset ${input.assetId}`);
      }
      const files = new Map(tip(input.assetId)?.files ?? []);
      files.set(skillMdPath(input.skillName), input.contents);
      const commitSha = `commit${String(nextSha++).padStart(4, "0")}`;
      const row = assets.get(input.assetId);
      // Only the skill's author may write (registry enforces this); attribute
      // the save to that principal rather than a machine account.
      const author = row?.creatorPrincipalId ?? "workbench";
      log.push({
        commit: {
          commitSha,
          message: input.message,
          author,
          committedAtIso: clock.now().toISOString(),
        },
        files,
      });
      if (row !== undefined) {
        assets.set(input.assetId, { ...row, updatedAt: clock.now() });
      }
      return { commitSha };
    },
    async readSkillMd(input) {
      const log = commits.get(input.assetId);
      if (log === undefined) return null;
      const path = skillMdPath(input.skillName);
      if (input.commitSha === undefined) {
        return tip(input.assetId)?.files.get(path) ?? null;
      }
      const found = log.find(
        (entry) => entry.commit.commitSha === input.commitSha,
      );
      return found?.files.get(path) ?? null;
    },
    async history(assetId) {
      const log = commits.get(assetId) ?? [];
      return [...log]
        .reverse()
        .map((entry) => entry.commit)
        .filter((commit) => !isAssetGenesisCommit(commit.message));
    },
  };
}
