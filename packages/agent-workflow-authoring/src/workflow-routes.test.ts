import { expect, test } from "bun:test";

import {
  createWorkflowAuthorRoutes,
  type WorkflowRunAuthenticator,
  type WorkflowRunScope,
} from "./workflow-routes";
import { WorkflowAuthorError } from "./errors";
import type { WorkflowAuthorRegistry } from "./registry";

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
    readSource: async () => {
      throw new Error("readSource not stubbed");
    },
    deploy: async () => {
      throw new Error("deploy not stubbed");
    },
    previewDeploy: async () => {
      throw new Error("previewDeploy not stubbed");
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

test("republish forwards expectedHeadSha and a conflict comes back 409 naming the current head", async () => {
  let seenExpected: string | undefined;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      republish: async (_caller, _assetId, input) => {
        seenExpected = input.expectedHeadSha;
        throw new WorkflowAuthorError("conflict", "asset moved", {
          currentHeadSha: "sha_current",
        });
      },
    }),
  });
  const res = await app.request(
    req("/republish", {
      assetId: "asset_1",
      files: { "package.json": "{}" },
      expectedHeadSha: "sha_stale",
    }),
  );
  expect(res.status).toBe(409);
  expect(seenExpected).toBe("sha_stale");
  const body = (await res.json()) as {
    error: { code: string };
    currentHeadSha: string;
  };
  expect(body.error.code).toBe("conflict");
  expect(body.currentHeadSha).toBe("sha_current");
});

test("GET /:assetId/source returns the registry's snapshot for the authenticated scope", async () => {
  let seen: { tenantId: string; assetId: string } | undefined;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      readSource: async (caller, assetId) => {
        seen = { tenantId: caller.tenantId, assetId };
        return {
          assetId,
          name: "daily-digest",
          headSha: "sha_head",
          files: { "package.json": "{}" },
        };
      },
    }),
  });
  const res = await app.request(
    new Request("https://hub.example.com/asset_1/source", {
      headers: {
        authorization: "Bearer sc-token",
        "x-workflow-run-address": "run_1@workflow",
      },
    }),
  );
  expect(res.status).toBe(200);
  expect(seen).toEqual({ tenantId: "tenant_1", assetId: "asset_1" });
  const body = (await res.json()) as { data: { headSha: string } };
  expect(body.data.headSha).toBe("sha_head");
});

test("POST /:assetId/deploy returns the deployment on the happy path", async () => {
  let seen: { assetId: string; commitSha: string; entry: string } | undefined;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      deploy: async (_caller, assetId, input) => {
        seen = { assetId, ...input };
        return {
          deploymentId: "run_1",
          definitionAssetId: assetId,
          status: "deployed",
        };
      },
    }),
  });
  const res = await app.request(
    req("/asset_1/deploy", { commitSha: "sha_1", entry: "./workflow.ts" }),
  );
  expect(res.status).toBe(201);
  expect(seen).toEqual({
    assetId: "asset_1",
    commitSha: "sha_1",
    entry: "./workflow.ts",
  });
  const body = (await res.json()) as {
    data: { deploymentId: string; status: string };
  };
  expect(body.data.deploymentId).toBe("run_1");
  expect(body.data.status).toBe("deployed");
});

test("POST /:assetId/deploy surfaces a forbidden deploy as 403, not a 500", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      deploy: async () => {
        throw new WorkflowAuthorError(
          "forbidden",
          'principal principal_1 is not granted "create" on "workflow:*"',
        );
      },
    }),
  });
  const res = await app.request(
    req("/asset_1/deploy", { commitSha: "sha_1", entry: "./workflow.ts" }),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("forbidden");
});

test("POST /:assetId/deploy surfaces a sidecar-unavailable deploy as 502", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      deploy: async () => {
        throw new WorkflowAuthorError("unavailable", "sidecar unreachable");
      },
    }),
  });
  const res = await app.request(
    req("/asset_1/deploy", { commitSha: "sha_1", entry: "./workflow.ts" }),
  );
  expect(res.status).toBe(502);
});

test("POST /:assetId/deploy/preview returns the walked grant surface without deploying", async () => {
  let deployCalled = false;
  let seen: { assetId: string; commitSha: string; entry: string } | undefined;
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      deploy: async () => {
        deployCalled = true;
        throw new Error("must not be called by a preview");
      },
      previewDeploy: async (_caller, assetId, input) => {
        seen = { assetId, ...input };
        return { wireHash: "wire_abc", grants: ["email:*/send"] };
      },
    }),
  });
  const res = await app.request(
    req("/asset_1/deploy/preview", {
      commitSha: "sha_1",
      entry: "./workflow.ts",
    }),
  );
  expect(res.status).toBe(200);
  expect(seen).toEqual({
    assetId: "asset_1",
    commitSha: "sha_1",
    entry: "./workflow.ts",
  });
  const body = (await res.json()) as {
    data: { wireHash: string; grants: string[] };
  };
  expect(body.data).toEqual({ wireHash: "wire_abc", grants: ["email:*/send"] });
  expect(deployCalled).toBe(false);
});

test("POST /:assetId/deploy surfaces a wire_hash_mismatch as 409, distinct from a plain conflict", async () => {
  const app = createWorkflowAuthorRoutes({
    authenticator: fakeAuthenticator({
      tenantId: "tenant_1",
      principalId: "principal_1",
    }),
    registry: fakeRegistry({
      deploy: async () => {
        throw new WorkflowAuthorError(
          "wire_hash_mismatch",
          "deploy succeeded but the frozen wire hash does not match the approved wire hash",
        );
      },
    }),
  });
  const res = await app.request(
    req("/asset_1/deploy", {
      commitSha: "sha_1",
      entry: "./workflow.ts",
      expectedWireHash: "wire_approved",
    }),
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("wire_hash_mismatch");
});
