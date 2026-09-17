// A definition's `workflow`-kind asset carries its own git history. The
// git history IS the version store here: no separate versions table, and
// restoring a version re-commits an older commit's blobs onto the default
// ref rather than rewriting history.
import fs from "node:fs";
import git from "isomorphic-git";

import { DEFAULT_ASSET_REF, type RepoId, type RepoStore } from "@intx/hub-sessions";

const AGENT_DEFINITION_ASSET_KIND = "workflow";

// The hub genesis commit message — substrate scaffolding from
// `createAsset` → `initRepo`, never a person-saved version, so it never
// surfaces in the version list a saver reads back.
const ASSET_GENESIS_COMMIT_MESSAGE = "Initialize repository";

function isAssetGenesisCommit(message: string): boolean {
  return message.trim() === ASSET_GENESIS_COMMIT_MESSAGE;
}

async function readAssetCommitHistory(input: {
  readonly repoStore: RepoStore;
  readonly kind: RepoId["kind"];
  readonly assetId: string;
  readonly ref: string;
}): Promise<readonly DefinitionCommit[]> {
  const dir = await input.repoStore.getRepoDir({
    kind: input.kind,
    id: input.assetId,
  });
  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({ fs, dir, ref: input.ref });
  } catch {
    // report-error-ignore: history is best-effort enrichment — an
    // unreadable ref reads back as no history rather than failing the page.
    return [];
  }
  const commits: DefinitionCommit[] = [];
  for (const entry of entries) {
    const message = entry.commit.message.trim();
    if (isAssetGenesisCommit(message)) continue;
    commits.push({
      commitSha: entry.oid,
      message,
      author: entry.commit.author.name,
      committedAtIso: new Date(entry.commit.author.timestamp * 1000).toISOString(),
    });
  }
  return commits;
}

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
      return readAssetCommitHistory({
        repoStore,
        kind: AGENT_DEFINITION_ASSET_KIND,
        assetId,
        ref: DEFAULT_ASSET_REF,
      });
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
