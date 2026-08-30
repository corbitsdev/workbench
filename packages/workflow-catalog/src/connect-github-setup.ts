// What runs once a person has actually picked repos on a room's GitHub
// connect card and starts reviewing. `instantiateWorkbenchTemplate`
// resolves a template at create time, before any repo is known; this
// module resolves the repo-scoped half once the person answers the
// connect card and creates the live webhook trigger per repo, mirroring
// `instantiate.ts`'s own shape exactly: pure orchestration over injected
// async ports, no HTTP, no store, testable with plain fakes.
import type { GitHubRepoSummary } from "@corbits/github-tools";

export interface ConnectGithubSetupPorts {
  /**
   * True once this repo already has the `repo:<repo.name>` grant —
   * checked before minting one, so a retry after a failure between
   * minting the grant and creating the trigger never mints a second
   * grant for a repo that already has one. The `grant` table
   * (`vendor/intx/db`) carries no unique constraint over
   * tenant/resource/action, so this read is the only thing standing
   * between a retry and a duplicate row. A host binds this to GET
   * `/api/tenants/:id/grants?resource=repo:<name>`.
   */
  hasRepoGrant(repo: GitHubRepoSummary): Promise<boolean>;
  /**
   * Mints one grant scoped to `repo:<repo.name>` (the `owner/name` full
   * name — the same `"<type>:<id>"` resource-string shape
   * `idResource("room", "id")` builds in `@intx/hub-api`'s grant
   * middleware, applied here to a repo instead of a room). A host binds
   * this to POST `/api/tenants/:id/grants`; this module never touches
   * drizzle directly.
   */
  mintRepoGrant(repo: GitHubRepoSummary): Promise<void>;
  /**
   * Creates the live `webhook_trigger` row this repo's pull-request-opened
   * events fire — the onboarding card's start-reviewing step is what
   * creates this trigger, for each repo the person picked. A host binds
   * this to `@corbits/webhook-triggers`' `WebhookTriggerStore.create`.
   */
  createWebhookTrigger(
    repo: GitHubRepoSummary,
  ): Promise<{ readonly id: string }>;
  /**
   * True once this repo already has a live webhook trigger — checked
   * before creating one, so a retry after a mid-loop failure (a repo
   * 1..N-1 already set up, N onward not) never mints a second trigger
   * for a repo a prior attempt already finished. A host binds this to a
   * read against `@corbits/webhook-triggers`' `WebhookTriggerStore.list`.
   *
   * This is never cleared on GitHub disconnect: nothing here disables or
   * deletes a trigger, so re-adding a repo after a reconnect finds its
   * old trigger still live and skips it rather than minting a new one —
   * intentional, not a gap this module owns closing.
   */
  hasWebhookTrigger(repo: GitHubRepoSummary): Promise<boolean>;
  /**
   * Records which repos this room is reviewing — the `template/*`
   * settings namespace's `selectedRepos` key (`./settings.ts`'s
   * `templateReposSettingsPatch`). A host binds this to the room's
   * existing settings PATCH route; the connect-github card refetches
   * its own state as the direct consequence of the call that triggers
   * this patch, never a fold off the resulting stream event.
   */
  persistSelectedRepos(repoIds: readonly string[]): Promise<void>;
}

export interface StartReviewingReposResult {
  readonly createdTriggerIds: readonly string[];
}

/**
 * Mints one grant and one webhook trigger per selected repo that doesn't
 * already have one, then records the selection. `repoIds` must all
 * resolve against `repos` — a caller passing an id `repos` doesn't carry
 * is a bug in how the connect card's own selection state was built, not
 * something to silently drop.
 *
 * Idempotent by construction: the grant and the trigger are each gated
 * on their own existence check, independently, rather than one check
 * guarding both — a retry after a failure between minting the grant and
 * creating the trigger must still create the trigger without re-minting
 * the grant, and a retry after a failure before the grant was minted
 * must still mint it. A repo both checks already report true for is
 * skipped entirely.
 */
export async function startReviewingRepos(
  repoIds: readonly string[],
  repos: readonly GitHubRepoSummary[],
  ports: ConnectGithubSetupPorts,
): Promise<StartReviewingReposResult> {
  const reposById = new Map(repos.map((repo) => [repo.id, repo]));
  const selected = repoIds.map((repoId) => {
    const repo = reposById.get(repoId);
    if (repo === undefined) {
      throw new Error(
        `startReviewingRepos was asked to review repo "${repoId}", which is not in the listed repos`,
      );
    }
    return repo;
  });

  const createdTriggerIds: string[] = [];
  for (const repo of selected) {
    if (!(await ports.hasRepoGrant(repo))) {
      await ports.mintRepoGrant(repo);
    }
    if (await ports.hasWebhookTrigger(repo)) {
      continue;
    }
    const trigger = await ports.createWebhookTrigger(repo);
    createdTriggerIds.push(trigger.id);
  }

  await ports.persistSelectedRepos(repoIds);

  return { createdTriggerIds };
}

/**
 * The one place the `webhook_trigger.name` convention for a repo's
 * pull-request-opened trigger is spelled out — both
 * `createWebhookTrigger`'s insert and `hasWebhookTrigger`'s lookup bind
 * against this, in `apps/hub`, so the two can never drift into matching
 * different strings.
 */
export function webhookTriggerName(repo: GitHubRepoSummary): string {
  return `${repo.name} pull-request-opened`;
}
