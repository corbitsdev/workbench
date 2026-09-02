import { expect, test } from "bun:test";

import {
  createWorkflowAuthorRoutes,
  type WorkflowRunAuthenticator,
  type WorkflowRunScope,
} from "./workflow-routes";
import { WorkflowAuthorError, type WorkflowAuthorRegistry } from "./registry";

function fakeAuthenticator(
  scope: WorkflowRunScope | null,
): WorkflowRunAuthenticator {
  return { resolve: async () => scope };
}

function fakeRegistry(
  overrides: Partial<WorkflowAuthorRegistry> = {},
): WorkflowAuthorRegistry {
  return {
    author: async () => {
      throw new Error("author not stubbed");
    },
    republish: async () => {
      throw new Error("republish not stubbed");
    },
    ...overrides,
  };
}

function req(path: string, body: unknown): Request {
  return new Request(`https://hub.example.com${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer sc-token",
      "x-workflow-run-address": "run_1@workflow",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("rejects a request with no recognizable sidecar bearer token", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator(null),
    registry: fakeRegistry(),
  });
  const res = await app.request(
    new Request("https://hub.example.com/author", {
      method: "POST",
      body: JSON.stringify({ name: "x", files: {} }),
    }),
  );
  expect(res.status).toBe(401);
});

test("author calls the registry with the resolved scope, never a caller-supplied identity", async () => {
  let seenScope: WorkflowRunScope | undefined;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      author: async (caller) => {
        seenScope = caller;
        return { assetId: "asset_1", name: "daily-digest", commitSha: "sha_1" };
      },
    }),
  });
  const res = await app.request(
    req("/author", { name: "daily-digest", files: { "package.json": "{}" } }),
  );
  expect(res.status).toBe(201);
  expect(seenScope).toEqual({
    tenantId: "tenant_1",
    principalId: "principal_1",
  });
});

test("a republish targeting another tenant's asset comes back not_found, not a 500", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      republish: async () => {
        throw new WorkflowAuthorError(
          "not_found",
          "no workflow asset asset_from_another_tenant in this tenant",
        );
      },
    }),
  });
  const res = await app.request(
    req("/republish", {
      assetId: "asset_from_another_tenant",
      files: { "index.ts": "x" },
    }),
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("not_found");
});

test("an invalid codebase (rejected by the workflow kind handler) comes back 400, not 500", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      author: async () => {
        throw new WorkflowAuthorError(
          "invalid",
          'package.json must declare a non-empty "interchange.workflow" entry',
        );
      },
    }),
  });
  const res = await app.request(
    req("/author", { name: "daily-digest", files: { "package.json": "{}" } }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    error: { code: string; userMessage: string; refId: string };
  };
  expect(body.error.code).toBe("invalid");
  expect(body.error.userMessage).toMatch(/interchange\.workflow/);
});

test("a malformed request body is rejected 400 before the registry ever runs", async () => {
  let called = false;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      author: async () => {
        called = true;
        throw new Error("must not be called");
      },
    }),
  });
  const res = await app.request(req("/author", { name: "daily-digest" }));
  expect(res.status).toBe(400);
  expect(called).toBe(false);
});
