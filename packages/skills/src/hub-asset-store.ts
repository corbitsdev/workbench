// The production `SkillAssetStore`: native `kind:"skill"` assets driven
// through the platform's own `AssetService` and `RepoStore`, exactly the
// seam `@corbits/agent-directory` already uses to materialize a
// `workflow`-kind asset in-process. No git subprocess and no second
// content store.
//
// Version history reads the asset repo's commit log directly
// (`isomorphic-git` over `repoStore.getRepoDir`, the same handle the
// platform's own `readAssetBlob` resolves through). The git history IS
// the version store: restoring a version re-commits an older commit's
// SKILL.md onto the default ref, so the rewind is itself a new commit
// and nothing about the history is rewritten.
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import git from "isomorphic-git";

import type { DB } from "@intx/db";
import { listAssetsForTenant, resolveAssetByName } from "@intx/db";
import { asset as assetTable } from "@intx/db/schema";
import {
  AssetServiceError,
  DEFAULT_ASSET_REF,
  type AssetService,
  type RepoStore,
} from "@intx/hub-sessions";

import { readAssetCommitHistory } from "./asset-history";
import {
  skillMdPath,
  type SkillAssetRow,
  type SkillAssetStore,
} from "./asset-store";

const SKILL_ASSET_KIND = "skill";

function rowToSkillAsset(row: typeof assetTable.$inferSelect): SkillAssetRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    displayName: row.displayName,
    creatorPrincipalId: row.creatorPrincipalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CreateHubSkillAssetStoreDeps = {
  db: DB["db"];
  assetService: AssetService;
  repoStore: RepoStore;
};

export function createHubSkillAssetStore(
  deps: CreateHubSkillAssetStoreDeps,
): SkillAssetStore {
  const { db, assetService, repoStore } = deps;

  async function repoDirFor(assetId: string): Promise<string> {
    return repoStore.getRepoDir({ kind: SKILL_ASSET_KIND, id: assetId });
  }

  return {
    async create(input) {
      const created = await assetService.createAsset({
        tenantId: input.tenantId,
        kind: SKILL_ASSET_KIND,
        name: input.name,
        displayName: input.displayName,
        creatorPrincipalId: input.creatorPrincipalId,
      });
      return {
        id: created.id,
        tenantId: created.tenantId,
        name: created.name,
        displayName: created.displayName,
        creatorPrincipalId: created.creatorPrincipalId,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    },

    async findByName(tenantId, name) {
      const row = await resolveAssetByName(
        db,
        tenantId,
        SKILL_ASSET_KIND,
        name,
      );
      return row === null ? null : rowToSkillAsset(row);
    },

    async findOwnByName(tenantId, name) {
      const row = await db.query.asset.findFirst({
        where: and(
          eq(assetTable.tenantId, tenantId),
          eq(assetTable.kind, SKILL_ASSET_KIND),
          eq(assetTable.name, name),
        ),
      });
      return row === undefined ? null : rowToSkillAsset(row);
    },

    async listForTenant(tenantId) {
      const rows = await listAssetsForTenant(db, tenantId, SKILL_ASSET_KIND);
      return rows.map(rowToSkillAsset);
    },

    async writeSkillMd(input) {
      const { commitSha } = await assetService.populateAsset({
        assetId: input.assetId,
        ref: DEFAULT_ASSET_REF,
        principal: { kind: "hub" },
        tree: {
          files: { [skillMdPath(input.skillName)]: input.contents },
          message: input.message,
        },
      });
      return { commitSha };
    },

    async readSkillMd(input) {
      const path = skillMdPath(input.skillName);
      if (input.commitSha === undefined) {
        try {
          const bytes = await assetService.readAssetBlob({
            assetId: input.assetId,
            path,
          });
          return new TextDecoder().decode(bytes);
        } catch (cause) {
          if (
            cause instanceof AssetServiceError &&
            cause.reason === "not_found"
          ) {
            return null;
          }
          throw cause;
        }
      }
      const dir = await repoDirFor(input.assetId);
      try {
        const { commit } = await git.readCommit({
          fs,
          dir,
          oid: input.commitSha,
        });
        const { blob } = await git.readBlob({
          fs,
          dir,
          oid: commit.tree,
          filepath: path,
        });
        return new TextDecoder().decode(blob);
      } catch {
        return null;
      }
    },

    async history(assetId) {
      // RepoStore always commits as `interchange-hub` (fixed git identity).
      // Only the skill's author may save, so attribute every consumer-visible
      // version to that principal — never the machine account.
      const commits = await readAssetCommitHistory({
        repoStore,
        kind: SKILL_ASSET_KIND,
        assetId,
        ref: DEFAULT_ASSET_REF,
      });
      const row = await db.query.asset.findFirst({
        where: eq(assetTable.id, assetId),
      });
      const author = row?.creatorPrincipalId;
      if (author === undefined || author === null || author === "") {
        return commits;
      }
      return commits.map((commit) => ({ ...commit, author }));
    },
  };
}
