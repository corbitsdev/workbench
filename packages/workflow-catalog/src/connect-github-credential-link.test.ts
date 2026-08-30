// CL-6463: the room's GitHub connect card submits a PAT through
// `@workbench/connections`' generic `persistConnectorCredential` (the
// exact sequence `POST /:connectorId/complete` runs) and reads its own
// connected state back through `createConnectGithubRoutes`' injected
// `resolveGithubConfig`. A host binds both against one real credential
// store, keyed by the `github` connector's own `CONNECTOR_REGISTRY`
// `displayName` (`apps/hub/src/index.ts`) -- never a second, hardcoded
// name literal that can drift out of step with it. This suite proves that
// contract with the real `persistConnectorCredential` and
// `createConnectGithubRoutes` functions, faking only the database layer
// underneath them: no real network, no real database.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { ApiCall, EnsureCredentialArgs } from "@workbench/hub-client";
import {
  CONNECTOR_REGISTRY,
  persistConnectorCredential,
} from "@workbench/connections";

import { createConnectGithubRoutes } from "./connect-github-routes";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_alice",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_alice",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

function mountAs(routes: Hono<TenantEnv>): Hono<TenantEnv> {
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

const fakeApi: ApiCall = async () => ({
  status: 200,
  data: undefined,
  cookies: [],
});

/** A minimal stand-in for the `credential` table: one row per name, the
 * exact shape `resolveCredentialByName` reads and `ensureCredential`
 * writes -- keyed by whatever name the caller passes, never assumed. */
function createFakeCredentialStore() {
  const rowsByName = new Map<string, { id: string; secret: string }>();
  let nextId = 1;
  const ensureCredentialFn = async (
    _api: ApiCall,
    _cookies: string[],
    args: EnsureCredentialArgs,
  ) => {
    const id = `crd_${String(nextId)}`;
    nextId += 1;
    rowsByName.set(args.name, { id, secret: args.secret });
    return id;
  };
  return {
    ensureCredentialFn,
    resolveByName: (name: string) => rowsByName.get(name),
  };
}

/** Builds the `resolveGithubConfig` port the exact way
 * `apps/hub/src/index.ts` does: read the credential row named by the
 * `github` connector's own `displayName`, never a second literal. */
function buildResolveGithubConfig(
  store: ReturnType<typeof createFakeCredentialStore>,
  credentialName: string,
) {
  return async (_tenantId: string) => {
    const row = store.resolveByName(credentialName);
    return row === undefined ? undefined : { apiKey: row.secret };
  };
}

/** `CONNECTOR_REGISTRY["github"]` is a fixed registry entry that always
 * exists; a missing one is a broken test fixture, not a case to assert
 * away with a non-null assertion. */
function requireGithubDescriptor() {
  const descriptor = CONNECTOR_REGISTRY["github"];
  if (descriptor === undefined) {
    throw new Error('CONNECTOR_REGISTRY has no "github" entry');
  }
  return descriptor;
}

describe("the room GitHub connect card reads what its own submit writes", () => {
  test("a PAT submitted through the connections' complete sequence is reported connected by the card's own state route", async () => {
    const store = createFakeCredentialStore();
    const githubDescriptor = requireGithubDescriptor();

    // The card's submit path: `POST /connections/github/complete` runs
    // this exact sequence once the PAT probe passes.
    await persistConnectorCredential({
      api: fakeApi,
      cookies: [],
      tenantId: TENANT.id,
      descriptor: githubDescriptor,
      secret: "ghp_test_token",
      log: () => {},
      ensureProviderFn: async () => "prv_github",
      ensureCredentialFn: store.ensureCredentialFn,
    });

    // The card's own read path, wired the way `apps/hub/src/index.ts`
    // wires it: keyed by `githubDescriptor.displayName`, the same field
    // `persistConnectorCredential` names the row with above.
    const routes = createConnectGithubRoutes({
      requireGrant: allowAll,
      log: () => {},
      resolveGithubConfig: buildResolveGithubConfig(
        store,
        githubDescriptor.displayName,
      ),
      resolveCodeReviewDefinitionId: async () => "wfd_code_review",
      acquireRepoReviewLease: async () => true,
      releaseRepoReviewLease: async () => {},
      hasRepoGrant: async () => false,
      mintRepoGrant: async () => {},
      createWebhookTrigger: async () => ({ id: "trg_1" }),
      hasWebhookTrigger: async () => false,
      getTemplateSettings: async () => ({
        pendingConnections: [],
        selectedRepos: [],
      }),
      persistSelectedRepos: async () => {},
      onReviewingStarted: async () => {},
      listReposFn: async () => [],
      fetchAuthenticatedLoginFn: async () => "octocat",
    });
    const app = mountAs(routes);

    const response = await app.request("/w_1/github/state");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("connected");
  });

  test("reading by any name other than the connector's own displayName silently leaves the card stuck disconnected -- this is the drift the two stores must never fall into", async () => {
    const store = createFakeCredentialStore();
    const githubDescriptor = requireGithubDescriptor();

    await persistConnectorCredential({
      api: fakeApi,
      cookies: [],
      tenantId: TENANT.id,
      descriptor: githubDescriptor,
      secret: "ghp_test_token",
      log: () => {},
      ensureProviderFn: async () => "prv_github",
      ensureCredentialFn: store.ensureCredentialFn,
    });

    // A second, independently-typed name -- e.g. the connector's `id`
    // instead of its `displayName` -- is exactly the kind of hardcoded
    // literal CL-6463 removed from `apps/hub/src/index.ts`. Reading by it
    // instead of the descriptor's own field reproduces the stuck card.
    const routes = createConnectGithubRoutes({
      requireGrant: allowAll,
      log: () => {},
      resolveGithubConfig: buildResolveGithubConfig(store, githubDescriptor.id),
      resolveCodeReviewDefinitionId: async () => "wfd_code_review",
      acquireRepoReviewLease: async () => true,
      releaseRepoReviewLease: async () => {},
      hasRepoGrant: async () => false,
      mintRepoGrant: async () => {},
      createWebhookTrigger: async () => ({ id: "trg_1" }),
      hasWebhookTrigger: async () => false,
      getTemplateSettings: async () => ({
        pendingConnections: [],
        selectedRepos: [],
      }),
      persistSelectedRepos: async () => {},
      onReviewingStarted: async () => {},
      listReposFn: async () => [],
      fetchAuthenticatedLoginFn: async () => "octocat",
    });
    const app = mountAs(routes);

    const response = await app.request("/w_1/github/state");
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("disconnected");
  });
});
