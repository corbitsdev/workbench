import { describe, expect, test } from "bun:test";

import {
  startReviewingRepos,
  webhookTriggerName,
  type ConnectGithubSetupPorts,
} from "./connect-github-setup";
import type { GitHubRepoSummary } from "@corbits/github-tools";

const REPOS: readonly GitHubRepoSummary[] = [
  { id: "1", name: "acme/widgets" },
  { id: "2", name: "acme/gadgets" },
  { id: "3", name: "acme/sprockets" },
];

function fakePorts() {
  const grantedRepos: string[] = [];
  const createdTriggerRepos: string[] = [];
  let persistedRepoIds: readonly string[] | undefined;
  const ports: ConnectGithubSetupPorts = {
    async acquireRepoReviewLease() {
      return true;
    },
    async releaseRepoReviewLease() {},
    async hasRepoGrant() {
      return false;
    },
    async mintRepoGrant(repo) {
      grantedRepos.push(repo.name);
    },
    async createWebhookTrigger(repo) {
      createdTriggerRepos.push(repo.name);
      return { id: `trg_${repo.id}` };
    },
    async hasWebhookTrigger() {
      return false;
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

/**
 * A grant-store- and `WebhookTriggerStore`-backed fake: `hasRepoGrant`
 * and `hasWebhookTrigger` each reflect what `mintRepoGrant` and
 * `createWebhookTrigger` have actually persisted so far — independently
 * of each other, the same as the real ports bind against the real
 * `grant` table and `WebhookTriggerStore.list`. Used to prove a retry
 * after a mid-loop failure is idempotent regardless of exactly where in
 * a repo's two steps the failure landed.
 */
function fakeBackedPorts() {
  const grantedRepoNames = new Set<string>();
  const existingTriggerRepoNames = new Set<string>();
  const leasedRepoNames = new Set<string>();
  const grantedRepos: string[] = [];
  const createdTriggerRepos: string[] = [];
  const ports: ConnectGithubSetupPorts = {
    // Synchronous check-and-set, same as the real lease's DB-side
    // compare-and-swap: two calls sharing this same `ports` object
    // (e.g. via `Promise.all`) race here exactly like two real
    // concurrent HTTP requests race the real `RepoReviewLeaseStore`.
    async acquireRepoReviewLease(repo) {
      if (leasedRepoNames.has(repo.name)) return false;
      leasedRepoNames.add(repo.name);
      return true;
    },
    async releaseRepoReviewLease(repo) {
      leasedRepoNames.delete(repo.name);
    },
    async hasRepoGrant(repo) {
      return grantedRepoNames.has(repo.name);
    },
    async mintRepoGrant(repo) {
      grantedRepos.push(repo.name);
      grantedRepoNames.add(repo.name);
    },
    async createWebhookTrigger(repo) {
      createdTriggerRepos.push(repo.name);
      existingTriggerRepoNames.add(repo.name);
      return { id: `trg_${repo.id}` };
    },
    async hasWebhookTrigger(repo) {
      return existingTriggerRepoNames.has(repo.name);
    },
    async persistSelectedRepos() {},
  };
  return { ports, grantedRepos, createdTriggerRepos };
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

  test("retrying after a mid-loop failure never mints a duplicate grant or trigger", async () => {
    const fake = fakeBackedPorts();
    const failingPorts: ConnectGithubSetupPorts = {
      ...fake.ports,
      async mintRepoGrant(repo) {
        if (repo.name === "acme/gadgets") {
          throw new Error("mint failed");
        }
        await fake.ports.mintRepoGrant(repo);
      },
    };

    await expect(
      startReviewingRepos(["1", "2", "3"], REPOS, failingPorts),
    ).rejects.toThrow(/mint failed/);

    // The first repo made it through before the failure; the other two
    // never got a grant or a trigger.
    expect(fake.grantedRepos).toEqual(["acme/widgets"]);
    expect(fake.createdTriggerRepos).toEqual(["acme/widgets"]);

    // Retrying the same selection (as the route's "Try again" does)
    // skips the repo that's already set up and only mints for the rest.
    const result = await startReviewingRepos(
      ["1", "2", "3"],
      REPOS,
      fake.ports,
    );

    expect(fake.grantedRepos).toEqual([
      "acme/widgets",
      "acme/gadgets",
      "acme/sprockets",
    ]);
    expect(fake.createdTriggerRepos).toEqual([
      "acme/widgets",
      "acme/gadgets",
      "acme/sprockets",
    ]);
    expect(result.createdTriggerIds).toEqual(["trg_2", "trg_3"]);
  });

  test("retrying after a failure between minting the grant and creating the trigger never re-mints the grant", async () => {
    const fake = fakeBackedPorts();
    const failingPorts: ConnectGithubSetupPorts = {
      ...fake.ports,
      async createWebhookTrigger(repo) {
        if (repo.name === "acme/gadgets") {
          throw new Error("trigger create failed");
        }
        return fake.ports.createWebhookTrigger(repo);
      },
    };

    await expect(
      startReviewingRepos(["1", "2", "3"], REPOS, failingPorts),
    ).rejects.toThrow(/trigger create failed/);

    // The failing repo's grant was minted before the trigger create blew
    // up; the repo after it was never reached at all.
    expect(fake.grantedRepos).toEqual(["acme/widgets", "acme/gadgets"]);
    expect(fake.createdTriggerRepos).toEqual(["acme/widgets"]);

    const result = await startReviewingRepos(
      ["1", "2", "3"],
      REPOS,
      fake.ports,
    );

    // acme/gadgets' grant is not re-minted on retry — only its missing
    // trigger is created.
    expect(fake.grantedRepos).toEqual([
      "acme/widgets",
      "acme/gadgets",
      "acme/sprockets",
    ]);
    expect(fake.createdTriggerRepos).toEqual([
      "acme/widgets",
      "acme/gadgets",
      "acme/sprockets",
    ]);
    expect(result.createdTriggerIds).toEqual(["trg_2", "trg_3"]);
  });

  test("two concurrent calls for the same repo mint exactly one grant and one trigger (CL-7242)", async () => {
    // Reconstructs the audit's own reproduction: `Promise.all` of two
    // concurrent `startReviewingRepos` calls sharing the same
    // backing state, for the same repo. Before the lease existed,
    // both calls' `hasRepoGrant`/`hasWebhookTrigger` reads landed
    // before either write, so both minted -- 2 grants, 2 triggers,
    // for one repo. `acquireRepoReviewLease`'s synchronous
    // check-and-set means only one of the two calls below ever gets
    // past the lease for "acme/widgets": the other's per-repo body
    // never runs at all.
    const fake = fakeBackedPorts();

    const [first, second] = await Promise.all([
      startReviewingRepos(["1"], REPOS, fake.ports),
      startReviewingRepos(["1"], REPOS, fake.ports),
    ]);

    expect(fake.grantedRepos).toEqual(["acme/widgets"]);
    expect(fake.createdTriggerRepos).toEqual(["acme/widgets"]);

    const totalCreated =
      first.createdTriggerIds.length + second.createdTriggerIds.length;
    expect(totalCreated).toBe(1);

    const totalSkipped =
      first.skippedRepoIds.length + second.skippedRepoIds.length;
    expect(totalSkipped).toBe(1);
  });
});

describe("webhookTriggerName", () => {
  test("names a repo's trigger consistently, the one convention both the create and the lookup bind against", () => {
    const repo: GitHubRepoSummary = {
      id: "1",
      name: "acme/widgets",
    };
    expect(webhookTriggerName(repo)).toBe("acme/widgets pull-request-opened");
  });
});
