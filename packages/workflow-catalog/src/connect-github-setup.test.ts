import { describe, expect, test } from "bun:test";

import {
  startReviewingRepos,
  type ConnectGithubSetupPorts,
} from "./connect-github-setup";
import type { GitHubRepoSummary } from "@corbits/github-tools";

const REPOS: readonly GitHubRepoSummary[] = [
  { id: "1", name: "acme/widgets", openPullRequestCount: 2 },
  { id: "2", name: "acme/gadgets", openPullRequestCount: 0 },
  { id: "3", name: "acme/sprockets", openPullRequestCount: 5 },
];

function fakePorts() {
  const grantedRepos: string[] = [];
  const createdTriggerRepos: string[] = [];
  let persistedRepoIds: readonly string[] | undefined;
  const ports: ConnectGithubSetupPorts = {
    async mintRepoGrant(repo) {
      grantedRepos.push(repo.name);
    },
    async createWebhookTrigger(repo) {
      createdTriggerRepos.push(repo.name);
      return { id: `trg_${repo.id}` };
    },
    async persistSelectedRepos(repoIds) {
      persistedRepoIds = repoIds;
    },
  };
  return {
    ports,
    grantedRepos,
    createdTriggerRepos,
    persistedRepoIds: () => persistedRepoIds,
  };
}

describe("startReviewingRepos", () => {
  test("mints a grant and a webhook trigger per selected repo, then persists the selection", async () => {
    const fake = fakePorts();
    const result = await startReviewingRepos(["1", "3"], REPOS, fake.ports);

    expect(fake.grantedRepos).toEqual(["acme/widgets", "acme/sprockets"]);
    expect(fake.createdTriggerRepos).toEqual([
      "acme/widgets",
      "acme/sprockets",
    ]);
    expect(result.createdTriggerIds).toEqual(["trg_1", "trg_3"]);
    expect(fake.persistedRepoIds()).toEqual(["1", "3"]);
  });

  test("never mints anything for a repo that isn't selected", async () => {
    const fake = fakePorts();
    await startReviewingRepos(["2"], REPOS, fake.ports);
    expect(fake.grantedRepos).toEqual(["acme/gadgets"]);
  });

  test("throws rather than silently dropping a repoId the listed repos don't carry", async () => {
    const fake = fakePorts();
    await expect(
      startReviewingRepos(["not-a-real-repo"], REPOS, fake.ports),
    ).rejects.toThrow(/not in the listed repos/);
    expect(fake.grantedRepos).toEqual([]);
  });
});
