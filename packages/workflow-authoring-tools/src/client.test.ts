import { expect, test } from "bun:test";

import {
  authorWorkflow,
  deployAuthoredWorkflow,
  republishWorkflow,
  DeployWorkflowError,
  WorkflowAuthoringError,
  type WorkflowAuthoringToolClientConfig,
} from "./client";

function testConfig(
  fetchImpl: typeof fetch,
): WorkflowAuthoringToolClientConfig {
  return {
    hubWorkflowAuthoringUrl: "https://hub.example.com",
    hubWorkflowsUrl: "https://hub.example.com",
    tenantId: "tenant_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("authorWorkflow posts to the workflow-authoring author endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        data: { assetId: "asset_1", name: "daily-digest", commitSha: "sha_1" },
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await authorWorkflow(testConfig(fetchImpl), {
    name: "daily-digest",
    files: { "package.json": "{}" },
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/author",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(seenBody).toEqual({
    name: "daily-digest",
    files: { "package.json": "{}" },
  });
  expect(result).toEqual({
    assetId: "asset_1",
    name: "daily-digest",
    commitSha: "sha_1",
  });
});

test("authorWorkflow throws WorkflowAuthoringError with the server's message on a 400 (invalid source)", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "invalid",
          message:
            'package.json must declare a non-empty "interchange.workflow" entry',
        },
      }),
      { status: 400 },
    )) as unknown as typeof fetch;

  const err = await authorWorkflow(testConfig(fetchImpl), {
    name: "daily-digest",
    files: { "package.json": "{}" },
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthoringError);
  expect((err as Error).message).toMatch(/interchange\.workflow/);
});

test("authorWorkflow throws WorkflowAuthoringError on a 403 (grant denied)", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "forbidden", message: "not granted create on asset:*" },
      }),
      { status: 403 },
    )) as unknown as typeof fetch;

  await expect(
    authorWorkflow(testConfig(fetchImpl), {
      name: "daily-digest",
      files: { "package.json": "{}" },
    }),
  ).rejects.toBeInstanceOf(WorkflowAuthoringError);
});

test("authorWorkflow throws an honest error on a non-4xx HTTP failure, never fabricating success", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(
    authorWorkflow(testConfig(fetchImpl), {
      name: "daily-digest",
      files: { "package.json": "{}" },
    }),
  ).rejects.toThrow(/500/);
});

test("republishWorkflow posts assetId + files to the republish endpoint", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        data: { assetId: "asset_1", name: "daily-digest", commitSha: "sha_2" },
      }),
    );
  }) as unknown as typeof fetch;

  const result = await republishWorkflow(testConfig(fetchImpl), {
    assetId: "asset_1",
    files: { "index.ts": "export {};" },
  });
  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/republish",
  );
  expect(seenBody).toEqual({
    assetId: "asset_1",
    files: { "index.ts": "export {};" },
  });
  expect(result.commitSha).toBe("sha_2");
});

test("republishWorkflow throws WorkflowAuthoringError on a 404 (cross-tenant or unknown asset)", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "not_found",
          message: "no workflow asset asset_x in this tenant",
        },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const err = await republishWorkflow(testConfig(fetchImpl), {
    assetId: "asset_x",
    files: { "index.ts": "x" },
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthoringError);
  expect((err as Error).message).toMatch(/no workflow asset/);
});

test("deployAuthoredWorkflow posts a source:asset deploy body to the tenant's existing deploy route", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "run_1",
        tenantId: "tenant_1",
        definitionAssetId: "asset_1",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await deployAuthoredWorkflow(testConfig(fetchImpl), {
    assetId: "asset_1",
    entry: "index.ts",
    sources: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    defaultSource: "src_1",
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/tenants/tenant_1/workflows/deployments",
  );
  expect(seenBody).toEqual({
    source: { kind: "asset", assetId: "asset_1" },
    entry: "index.ts",
    sources: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    defaultSource: "src_1",
  });
  expect(result.status).toBe("deployed");
});

test("deployAuthoredWorkflow throws DeployWorkflowError on a 409 (invalid definition), never a raw 500-shaped failure", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "invalid_workflow", message: "definition failed probe" },
      }),
      { status: 409 },
    )) as unknown as typeof fetch;

  const err = await deployAuthoredWorkflow(testConfig(fetchImpl), {
    assetId: "asset_1",
    entry: "index.ts",
    sources: [{ id: "src_1", provider: "anthropic", model: "claude" }],
    defaultSource: "src_1",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DeployWorkflowError);
  expect((err as Error).message).toMatch(/failed probe/);
});
