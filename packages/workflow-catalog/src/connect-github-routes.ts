// The room's own GitHub connect card, wired to real ports (CL-6344): the
// production half of `./connect-github-setup.ts`'s `startReviewingRepos`
// and the read side `@corbits/chat-ui`'s `ConnectGithubActions` polls.
// Mounted per-workbench, inside the platform's native tenant middleware
// (`TenantEnv`'s `tenant`/`principal` resolved before any handler here
// runs), the same way `@corbits/webhook-triggers`' management routes and
// `@workbench/connections`' routes are.
//
// Connecting the PAT itself is deliberately NOT a route here —
// `@corbits/chat-ui`'s `connect-github-actions.ts` header already says
// why: `@workbench/connections`' generic `/:connectorId/complete` (with
// `connectorId: "github"`, already registered in `CONNECTOR_REGISTRY`) is
// the credential test-and-store surface, and this module never
// reimplements it. What this module owns is the two things that need the
// decrypted secret and the live repo list: reading the connect card's
// state, and starting reviews once repos are picked.
//
// Every side effect a host needs — decrypting the tenant's GitHub
// credential, minting a grant, creating a live `webhook_trigger` row,
// resolving the deployed code-review workflow definition, and patching
// the room's settings — arrives as an injected port, exactly like
// `@workbench/connections`' `createConnectionRoutes`. `apps/hub` is the
// only caller that binds these against drizzle; this module never touches
// it, so it stays testable with plain fakes (`./connect-github-routes.test.ts`).
import { Hono } from "hono";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  fetchAuthenticatedLogin,
  listRepos,
  type GitHubClientConfig,
  type GitHubRepoSummary,
} from "@corbits/github-tools";

import { startReviewingRepos } from "./connect-github-setup";
import { templateReposSettingsPatch } from "./settings";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

// `startReviewingRepos`' own selected-repo mismatch throw and a GitHub
// client failure both carry provider/internal detail (a rejected repo id,
// an HTTP status line) that a person pasting a token never needs to read —
// the CL-6360 idiom this route follows throughout: log the real cause,
// answer with one honest, actionable sentence.
const REPOS_UNREADABLE_MESSAGE =
  "Couldn't read your GitHub repositories. Try reconnecting.";
const START_REVIEWING_FAILED_MESSAGE =
  "Couldn't start reviewing those repositories. Try again in a moment.";

const StartReviewingBody = type({
  repoIds: "string[]",
});

export type ConnectGithubTemplateSettings = {
  readonly pendingConnections: readonly string[];
  readonly selectedRepos: readonly string[];
};

export type ConnectGithubRoutesDeps = {
  requireGrant: RequireGrant;
  /** The tenant's decrypted GitHub PAT, ready to hand `@corbits/github-tools`
   * — `undefined` when no `github` credential resolves for this tenant
   * (nothing connected yet). A host binds this to `resolveCredentialByName`
   * + `CredentialCipher.decrypt` against the `github` connector's own
   * `CONNECTOR_REGISTRY` credential name, the same secret
   * `buildCredentialDelivery` decrypts for a tool binding — never a second,
   * bespoke credential store. */
  resolveGithubConfig(
    tenantId: string,
  ): Promise<GitHubClientConfig | undefined>;
  /** The tenant's deployed `code-review` workflow definition id —
   * `undefined` when the template's own workflow was never deployed for
   * this tenant (a create-flow bug, not something this route can fix). */
  resolveCodeReviewDefinitionId(tenantId: string): Promise<string | undefined>;
  /** Mints the `repo:<owner/name>`-scoped grant a launched review run
   * needs to read this repo — see `./connect-github-setup.ts`'s
   * `ConnectGithubSetupPorts.mintRepoGrant` for the exact resource shape. */
  mintRepoGrant(tenantId: string, repo: GitHubRepoSummary): Promise<void>;
  /** Creates the live `webhook_trigger` row this repo's pull-request-opened
   * events fire, scoped to the resolved code-review definition. A host
   * binds this to `@corbits/webhook-triggers`' `WebhookTriggerStore.create`. */
  createWebhookTrigger(
    tenantId: string,
    principalId: string,
    codeReviewDefinitionId: string,
    repo: GitHubRepoSummary,
  ): Promise<{ readonly id: string }>;
  /** The room's current `template/*` settings — read before every
   * `start-reviewing` write so the state read and the persisted patch
   * never race a stale pending-connections list. */
  getTemplateSettings(
    tenantId: string,
    workbenchId: string,
  ): Promise<ConnectGithubTemplateSettings>;
  /** Applies the settings PATCH `./settings.ts`'s
   * `templateReposSettingsPatch` builds and publishes the room's
   * `chat.settings` stream event — the same event `applyConnectGithubSettingsEvent`
   * (`@corbits/chat-ui`) folds the connect card's live state from. */
  persistSelectedRepos(
    tenantId: string,
    workbenchId: string,
    principalId: string,
    patch: ReturnType<typeof templateReposSettingsPatch>,
  ): Promise<void>;
  /** Test-only override, defaulting to `@corbits/github-tools`' real
   * `listRepos` — lets `connect-github-routes.test.ts` stub the GitHub
   * client without reaching for module mocking or the real network. */
  listReposFn?: typeof listRepos;
  /** Test-only override, matching `listReposFn`'s pattern. */
  fetchAuthenticatedLoginFn?: typeof fetchAuthenticatedLogin;
};

export function createConnectGithubRoutes(
  deps: ConnectGithubRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const runListRepos = deps.listReposFn ?? listRepos;
  const runFetchAuthenticatedLogin =
    deps.fetchAuthenticatedLoginFn ?? fetchAuthenticatedLogin;

  async function readGithubState(
    tenantId: string,
    config: GitHubClientConfig,
  ): Promise<
    | {
        ok: true;
        orgName: string;
        repos: readonly GitHubRepoSummary[];
      }
    | { ok: false }
  > {
    try {
      const [orgName, repos] = await Promise.all([
        runFetchAuthenticatedLogin(config),
        runListRepos(config),
      ]);
      return { ok: true, orgName, repos };
    } catch {
      // The GitHub client's own errors (transport, HTTP status, shape
      // mismatch) carry no actionable detail for the person who pasted a
      // token — see this module's own `REPOS_UNREADABLE_MESSAGE` comment.
      // `tenantId` is accepted for a future host-side log line; this route
      // has no logger port today.
      void tenantId;
      return { ok: false };
    }
  }

  app.get(
    "/:workbenchId/github/state",
    deps.requireGrant("credential:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("workbenchId");
      const config = await deps.resolveGithubConfig(tenant.id);
      if (config === undefined) {
        return c.json({ kind: "disconnected" }, 200);
      }

      const state = await readGithubState(tenant.id, config);
      if (!state.ok) {
        return c.json(
          { kind: "error", message: REPOS_UNREADABLE_MESSAGE },
          200,
        );
      }

      const settings = await deps.getTemplateSettings(tenant.id, workbenchId);
      return c.json(
        {
          kind: "connected",
          orgName: state.orgName,
          repos: state.repos,
          selectedRepoIds: settings.selectedRepos,
        },
        200,
      );
    },
  );

  app.post(
    "/:workbenchId/github/start-reviewing",
    deps.requireGrant("credential:*", "read"),
    async (c) => {
      const body = StartReviewingBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", "Pick at least one repository."),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("workbenchId");

      const config = await deps.resolveGithubConfig(tenant.id);
      if (config === undefined) {
        return c.json(
          ErrorEnvelope("not_connected", "Connect GitHub first."),
          409,
        );
      }

      const state = await readGithubState(tenant.id, config);
      if (!state.ok) {
        return c.json(
          ErrorEnvelope("upstream_unavailable", REPOS_UNREADABLE_MESSAGE),
          502,
        );
      }

      const codeReviewDefinitionId = await deps.resolveCodeReviewDefinitionId(
        tenant.id,
      );
      if (codeReviewDefinitionId === undefined) {
        return c.json(
          ErrorEnvelope(
            "not_found",
            "This workbench's code-review workflow isn't set up yet.",
          ),
          404,
        );
      }

      try {
        const result = await startReviewingRepos(body.repoIds, state.repos, {
          mintRepoGrant: (repo) => deps.mintRepoGrant(tenant.id, repo),
          createWebhookTrigger: (repo) =>
            deps.createWebhookTrigger(
              tenant.id,
              principal.id,
              codeReviewDefinitionId,
              repo,
            ),
          persistSelectedRepos: async (repoIds) => {
            const settings = await deps.getTemplateSettings(
              tenant.id,
              workbenchId,
            );
            const pendingConnections = settings.pendingConnections.filter(
              (id) => id !== "github",
            );
            await deps.persistSelectedRepos(
              tenant.id,
              workbenchId,
              principal.id,
              templateReposSettingsPatch(pendingConnections, repoIds),
            );
          },
        });
        return c.json(
          { startedTriggerCount: result.createdTriggerIds.length },
          200,
        );
      } catch {
        // A repoId `state.repos` doesn't carry means the card's own
        // selection state is stale against a live re-list — never
        // something a raw stack trace helps the person fix.
        return c.json(
          ErrorEnvelope("bad_request", START_REVIEWING_FAILED_MESSAGE),
          400,
        );
      }
    },
  );

  return app;
}
