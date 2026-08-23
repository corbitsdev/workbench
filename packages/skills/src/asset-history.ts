// The commit-log walk shared by every asset kind whose version history IS
// its git history: `isomorphic-git`'s `git.log` over the repo `RepoStore`
// resolves for a given `{ kind, id }`. Both `@corbits/skills`' skill assets
// and `@corbits/agent-directory`'s workflow-kind definition assets read
// their history through this one walk.
//
// Consumer history omits the hub's genesis commit — every `createAsset` →
// `initRepo` path writes an "Initialize repository" scaffolding commit
// authored as interchange-hub. That is substrate, not a person-saved
// version, so it never surfaces in the version list a saver reads back.
import fs from "node:fs";
import git from "isomorphic-git";

import type { RepoId, RepoStore } from "@intx/hub-sessions";

import type { SkillCommit } from "./asset-store";

/** The hub genesis commit message — substrate scaffolding, not a save. */
export const ASSET_GENESIS_COMMIT_MESSAGE = "Initialize repository";

export function isAssetGenesisCommit(message: string): boolean {
  return message.trim() === ASSET_GENESIS_COMMIT_MESSAGE;
}

export async function readAssetCommitHistory(input: {
  readonly repoStore: RepoStore;
  readonly kind: RepoId["kind"];
  readonly assetId: string;
  readonly ref: string;
}): Promise<readonly SkillCommit[]> {
  const dir = await input.repoStore.getRepoDir({
    kind: input.kind,
    id: input.assetId,
  });
  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({ fs, dir, ref: input.ref });
  } catch {
    return [];
  }
  const commits: SkillCommit[] = [];
  for (const entry of entries) {
    const message = entry.commit.message.trim();
    if (isAssetGenesisCommit(message)) continue;
    commits.push({
      commitSha: entry.oid,
      message,
      author: entry.commit.author.name,
      committedAtIso: new Date(
        entry.commit.author.timestamp * 1000,
      ).toISOString(),
    });
  }
  return commits;
}
