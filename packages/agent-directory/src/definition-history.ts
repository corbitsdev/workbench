// A definition's `workflow`-kind asset carries its own git history —
// exactly the seam `@corbits/skills`' `createHubSkillAssetStore` reads
// commit logs through (`isomorphic-git` over `RepoStore.getRepoDir`, the
// same handle `AssetService` resolves through). The git history IS the
// version store here too: no separate versions table, and restoring a
// version re-commits an older commit's blobs onto the default ref rather
// than rewriting history.
import fs from "node:fs";
import git from "isomorphic-git";

import { DEFAULT_ASSET_REF, type RepoStore } from "@intx/hub-sessions";

const AGENT_DEFINITION_ASSET_KIND = "workflow";

/** One commit on a definition's asset default ref. */
export type DefinitionCommit = {
  readonly commitSha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAtIso: string;
};

export type DefinitionAssetHistory = {
  /** Every commit on `assetId`'s default ref, newest first. An asset with
   * no commits yet (or no repo at all) reads as an empty list, never an
   * error. */
  history(assetId: string): Promise<readonly DefinitionCommit[]>;
  /** The bytes `path` held at `commitSha`, or `null` if that commit never
   * carried the path. */
  readBlobAtCommit(input: {
    readonly assetId: string;
    readonly path: string;
    readonly commitSha: string;
  }): Promise<Uint8Array | null>;
};

export function createDefinitionAssetHistory(deps: {
  repoStore: RepoStore;
}): DefinitionAssetHistory {
  const { repoStore } = deps;

  async function repoDirFor(assetId: string): Promise<string> {
    return repoStore.getRepoDir({
      kind: AGENT_DEFINITION_ASSET_KIND,
      id: assetId,
    });
  }

  return {
    async history(assetId) {
      const dir = await repoDirFor(assetId);
      let entries: Awaited<ReturnType<typeof git.log>>;
      try {
        entries = await git.log({ fs, dir, ref: DEFAULT_ASSET_REF });
      } catch {
        return [];
      }
      const commits: DefinitionCommit[] = [];
      for (const entry of entries) {
        commits.push({
          commitSha: entry.oid,
          message: entry.commit.message.trim(),
          author: entry.commit.author.name,
          committedAtIso: new Date(
            entry.commit.author.timestamp * 1000,
          ).toISOString(),
        });
      }
      return commits;
    },

    async readBlobAtCommit({ assetId, path, commitSha }) {
      const dir = await repoDirFor(assetId);
      try {
        const { commit } = await git.readCommit({ fs, dir, oid: commitSha });
        const { blob } = await git.readBlob({
          fs,
          dir,
          oid: commit.tree,
          filepath: path,
        });
        return blob;
      } catch {
        return null;
      }
    },
  };
}
