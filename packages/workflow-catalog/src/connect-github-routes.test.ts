// Exercises `createConnectGithubRoutes`' HTTP surface end to end through
// the real `startReviewingRepos` orchestration (`./connect-github-setup`),
// mounted the same way `packages/connections/src/routes.test.ts` mounts
// its own routes: a bare `Hono` with a tenant-injecting middleware, no
// real network, no real database — every port is a plain fake.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type {
  GitHubClientConfig,
  GitHubRepoSummary,
} from "@corbits/github-tools";

import {
  createConnectGithubRoutes,
  type ConnectGithubRoutesDeps,
} from "./connect-github-routes";

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

const REPOS: readonly GitHubRepoSummary[] = [
  { id: "1", name: "acme/widgets", openPullRequestCount: 2 },
  { id: "2", name: "acme/gadgets", openPullRequestCount: 0 },
];

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

function buildApp(overrides: Partial<ConnectGithubRoutesDeps> = {}) {
  const grants: { tenantId: string; repo: GitHubRepoSummary }[] = [];
  const triggers: { tenantId: string; repo: GitHubRepoSummary }[] = [];
  const introductionCalls: {
    tenantId: string;
    workbenchId: string;
    principalId: string;
    introductions: readonly { handle: string; text: string }[];
  }[] = [];
  let settings: {
    pendingConnections: readonly string[];
    selectedRepos: readonly string[];
  } = { pendingConnections: ["github"], selectedRepos: [] };
  const githubConfig: GitHubClientConfig | undefined = { apiKey: "ghp_test" };

  const deps: ConnectGithubRoutesDeps = {
    requireGrant: allowAll,
    log: () => {},
    resolveGithubConfig: async () => githubConfig,
    resolveCodeReviewDefinitionId: async () => "wfd_code_review",
    mintRepoGrant: async (tenantId, repo) => {
      grants.push({ tenantId, repo });
    },
    createWebhookTrigger: async (
      tenantId,
      _principalId,
      _definitionId,
      repo,
    ) => {
      triggers.push({ tenantId, repo });
      return { id: `trg_${repo.id}` };
    },
    getTemplateSettings: async () => settings,
    persistSelectedRepos: async (
      _tenantId,
      _workbenchId,
      _principalId,
      patch,
    ) => {
      settings = {
        pendingConnections: patch["template/pendingConnections"],
        selectedRepos: patch["template/selectedRepos"],
      };
    },
    onReviewingStarted: async (
      tenantId,
      workbenchId,
      principalId,
      introductions,
    ) => {
      introductionCalls.push({
        tenantId,
        workbenchId,
        principalId,
        introductions,
      });
    },
    listReposFn: async () => REPOS,
    fetchAuthenticatedLoginFn: async () => "octocat",
    ...overrides,
  };

  const routes = createConnectGithubRoutes(deps);
  return {
    app: mountAs(routes),
    grants,
    triggers,
    introductionCalls,
    settingsNow: () => settings,
  };
}

describe("GET /:workbenchId/github/state", () => {
  test("reports disconnected with no github credential", async () => {
    const { app } = buildApp({ resolveGithubConfig: async () => undefined });
    const response = await app.request("/wb_1/github/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "disconnected" });
  });

  test("reports connected repos and the room's selected ids once a credential exists", async () => {
    const { app } = buildApp();
    const response = await app.request("/wb_1/github/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "connected",
      orgName: "octocat",
      repos: REPOS,
      selectedRepoIds: [],
    });
  });

  test("surfaces a consumer-language error, never the raw GitHub failure, on a listRepos throw", async () => {
    const { app } = buildApp({
      listReposFn: async () => {
        throw new Error(
          "GitHub request to /user/repos failed: 401 Bad credentials",
        );
      },
    });
    const response = await app.request("/wb_1/github/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "error",
      message: "Couldn't read your GitHub repositories. Try reconnecting.",
    });
  });
});

describe("POST /:workbenchId/github/start-reviewing", () => {
  test("mints a grant and a live webhook trigger per repo, then persists the selection", async () => {
    const harness = buildApp();
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1", "2"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ startedTriggerCount: 2 });
    expect(harness.grants.map((g) => g.repo.name)).toEqual([
      "acme/widgets",
      "acme/gadgets",
    ]);
    expect(harness.triggers.map((t) => t.repo.name)).toEqual([
      "acme/widgets",
      "acme/gadgets",
    ]);
    expect(harness.settingsNow()).toEqual({
      pendingConnections: [],
      selectedRepos: ["1", "2"],
    });
  });

  test("posts each reviewer's introduction once, naming the selected repos, after success", async () => {
    const harness = buildApp();
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1", "2"] }),
    });
    expect(response.status).toBe(200);
    expect(harness.introductionCalls.length).toBe(1);
    const [call] = harness.introductionCalls;
    if (call === undefined) throw new Error("expected one introduction call");
    expect(call.tenantId).toBe("tnt_1");
    expect(call.workbenchId).toBe("wb_1");
    expect(call.principalId).toBe("prn_alice");
    expect(call.introductions.length).toBe(3);
    for (const introduction of call.introductions) {
      expect(
        ["acme/widgets", "acme/gadgets"].some((name) =>
          introduction.text.includes(name),
        ),
      ).toBe(true);
    }
  });

  test("a rejecting introduction port still yields 200 and logs the failure", async () => {
    const logs: string[] = [];
    const harness = buildApp({
      log: (line) => logs.push(line),
      onReviewingStarted: async () => {
        throw new Error("boom");
      },
    });
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1"] }),
    });
    expect(response.status).toBe(200);
    expect(logs.some((line) => line.includes("boom"))).toBe(true);
  });

  test("400s on a malformed body without leaking raw parser text", async () => {
    const harness = buildApp();
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: "not-an-array" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
    expect(harness.introductionCalls).toEqual([]);
  });

  test("409s when the tenant has no github credential yet", async () => {
    const harness = buildApp({ resolveGithubConfig: async () => undefined });
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1"] }),
    });
    expect(response.status).toBe(409);
    expect(harness.grants).toEqual([]);
    expect(harness.introductionCalls).toEqual([]);
  });

  test("502s when GitHub cannot be read, without posting introductions", async () => {
    const harness = buildApp({
      listReposFn: async () => {
        throw new Error(
          "GitHub request to /user/repos failed: 401 Bad credentials",
        );
      },
    });
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1"] }),
    });
    expect(response.status).toBe(502);
    expect(harness.introductionCalls).toEqual([]);
  });

  test("404s when the code-review workflow isn't deployed in this tenant", async () => {
    const harness = buildApp({
      resolveCodeReviewDefinitionId: async () => undefined,
    });
    const response = await harness.app.request("/wb_1/github/start-reviewing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoIds: ["1"] }),
    });
    expect(response.status).toBe(404);
    expect(harness.grants).toEqual([]);
    expect(harness.introductionCalls).toEqual([]);
  });
});
