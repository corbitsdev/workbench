// The commit-log walk shared by every asset kind whose version history IS
// its git history: `isomorphic-git`'s `git.log` over the repo `RepoStore`
// resolves for a given `{ kind, id }`. Both `@corbits/skills`' skill assets
// and `@corbits/agent-directory`'s workflow-kind definition assets read
// their history through this one walk.
import fs from "node:fs";
import git from "isomorphic-git";

import type { RepoId, RepoStore } from "@intx/hub-sessions";

import type { SkillCommit } from "./asset-store";

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
}
