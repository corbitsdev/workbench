import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  workflowAuthoringTools,
  AUTHOR_WORKFLOW_TOOL,
  DEPLOY_WORKFLOW_TOOL,
  type WorkflowAuthoringEnv,
} from "./tool";

function testEnv(): WorkflowAuthoringEnv {
  return {
    hubWorkflowAuthoringUrl: "https://hub.example.com",
    hubWorkflowsUrl: "https://hub.example.com",
    tenantId: "tenant_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAuthoringEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares exactly author_workflow and deploy_workflow", () => {
  const bundle = workflowAuthoringTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    AUTHOR_WORKFLOW_TOOL,
    DEPLOY_WORKFLOW_TOOL,
  ]);
});

test("requires the sanctioned env keys", () => {
  expect(workflowAuthoringTools.requires).toEqual([
    "hubWorkflowAuthoringUrl",
    "hubWorkflowsUrl",
    "tenantId",
    "sidecarToken",
    "address",
  ]);
});

test("author_workflow carries no approval key; deploy_workflow requires human approval", () => {
  expect(workflowAuthoringTools.definitions).toEqual([
    { name: AUTHOR_WORKFLOW_TOOL },
    { name: DEPLOY_WORKFLOW_TOOL, approval: "ask" },
  ]);
});

test("author_workflow rejects a call missing required fields, without a raw throw", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  const result = await bundle.run(
    callFor(AUTHOR_WORKFLOW_TOOL, { name: "daily-digest" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("deploy_workflow rejects a call missing required fields, without a raw throw", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  const result = await bundle.run(
    callFor(DEPLOY_WORKFLOW_TOOL, { assetId: "asset_1" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("an unknown tool name returns an honest error", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});

test("author_workflow publishes a new workflow asset and reports its asset id", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl: string | undefined;
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(
      JSON.stringify({
        data: { assetId: "asset_1", name: "daily-digest", commitSha: "sha_1" },
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = workflowAuthoringTools(testEnv());
    const result = await bundle.run(
      callFor(AUTHOR_WORKFLOW_TOOL, {
        name: "daily-digest",
        files: { "package.json": "{}" },
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("asset_1");
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-workflow-authoring/author",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("author_workflow republishes when given assetId, calling the republish endpoint instead of author", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl: string | undefined;
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(
      JSON.stringify({
        data: { assetId: "asset_1", name: "daily-digest", commitSha: "sha_2" },
      }),
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = workflowAuthoringTools(testEnv());
    const result = await bundle.run(
      callFor(AUTHOR_WORKFLOW_TOOL, {
        name: "daily-digest",
        assetId: "asset_1",
        files: { "index.ts": "export {};" },
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-workflow-authoring/republish",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("author_workflow reports a rejected codebase honestly rather than a generic failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
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
  try {
    const bundle = workflowAuthoringTools(testEnv());
    const result = await bundle.run(
      callFor(AUTHOR_WORKFLOW_TOOL, {
        name: "daily-digest",
        files: { "package.json": "{}" },
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/interchange\.workflow/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deploy_workflow reports the deployment id and status on success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "run_1",
        tenantId: "tenant_1",
        definitionAssetId: "asset_1",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      { status: 201 },
    )) as unknown as typeof fetch;
  try {
    const bundle = workflowAuthoringTools(testEnv());
    const result = await bundle.run(
      callFor(DEPLOY_WORKFLOW_TOOL, {
        assetId: "asset_1",
        entry: "index.ts",
        sources: [{ id: "src_1", provider: "anthropic", model: "claude" }],
        defaultSource: "src_1",
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("run_1");
    expect(result.content).toContain("deployed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
