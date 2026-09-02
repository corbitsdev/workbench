import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  workflowAuthoringTools,
  WORKFLOW_AUTHOR_TOOL,
  WORKFLOW_DEPLOY_PREVIEW_TOOL,
  WORKFLOW_DEPLOY_TOOL,
  WORKFLOW_REPUBLISH_TOOL,
  WORKFLOW_SOURCE_READ_TOOL,
  type WorkflowAuthoringEnv,
} from "./tool";

function testEnv(): WorkflowAuthoringEnv {
  return {
    hubWorkflowAuthoringUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAuthoringEnv;
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

async function withFetch<T>(
  impl: (url: string, init?: RequestInit) => Response,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
    impl(String(url), init)) as unknown as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test("declares the four no-approval tools with workflow_deploy alone behind approval: ask", () => {
  expect(workflowAuthoringTools.definitions).toEqual([
    { name: WORKFLOW_AUTHOR_TOOL },
    { name: WORKFLOW_REPUBLISH_TOOL },
    { name: WORKFLOW_SOURCE_READ_TOOL },
    { name: WORKFLOW_DEPLOY_PREVIEW_TOOL },
    { name: WORKFLOW_DEPLOY_TOOL, approval: "ask" },
  ]);
  expect(workflowAuthoringTools.requires).toEqual([
    "hubWorkflowAuthoringUrl",
    "sidecarToken",
    "address",
  ]);
});

test("every description tells the model the package shape and that deploy is a separate step", () => {
  const bundle = workflowAuthoringTools(testEnv());
  const byName = new Map(
    bundle.definitions.map((definition) => [
      definition.name,
      (definition as unknown as { description: string }).description,
    ]),
  );
  for (const name of [WORKFLOW_AUTHOR_TOOL, WORKFLOW_REPUBLISH_TOOL]) {
    const description = byName.get(name) ?? "";
    expect(description).toContain('"interchange": { "workflow"');
    expect(description).toContain("defineWorkflow");
    expect(description).toContain("@intx/workflow");
    expect(description).toMatch(/separate/);
  }
});

test("workflow_author rejects a call missing files without calling the hub", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  await withFetch(
    () => {
      throw new Error("must not be called");
    },
    async () => {
      await expect(
        bundle.run(
          call(WORKFLOW_AUTHOR_TOOL, { name: "daily-digest" }),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/invalid input/);
    },
  );
});

test("workflow_author posts to the authoring route and reports asset id and commit", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  let seenUrl: string | undefined;
  const result = await withFetch(
    (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({
          data: {
            assetId: "asset_1",
            name: "daily-digest",
            commitSha: "sha_1",
          },
        }),
        { status: 201 },
      );
    },
    () =>
      bundle.run(
        call(WORKFLOW_AUTHOR_TOOL, {
          name: "daily-digest",
          files: { "package.json": "{}", "workflow.ts": "" },
        }),
        new AbortController().signal,
      ),
  );
  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/author",
  );
  expect(result.isError).toBe(false);
  expect(result.content).toContain("asset_1");
  expect(result.content).toContain("sha_1");
  expect(result.content).toMatch(/until deployed/);
});

test("workflow_republish surfaces a head conflict with the current sha in the thrown message", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "conflict",
            userMessage:
              "workflow asset asset_1 moved: expected head sha_stale but refs/heads/main is at sha_current",
            refId: "ref_1",
          },
          currentHeadSha: "sha_current",
        }),
        { status: 409 },
      ),
    async () => {
      await expect(
        bundle.run(
          call(WORKFLOW_REPUBLISH_TOOL, {
            assetId: "asset_1",
            files: { "workflow.ts": "" },
            expectedHeadSha: "sha_stale",
          }),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/sha_current/);
    },
  );
});

test("workflow_source_read returns the snapshot as JSON the model can parse", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  const snapshot = {
    assetId: "asset_1",
    name: "daily-digest",
    headSha: "sha_head",
    files: { "package.json": "{}" },
  };
  const result = await withFetch(
    (url) => {
      expect(url).toBe(
        "https://hub.example.com/api/workflow-workflow-authoring/asset_1/source",
      );
      return new Response(JSON.stringify({ data: snapshot }));
    },
    () =>
      bundle.run(
        call(WORKFLOW_SOURCE_READ_TOOL, { assetId: "asset_1" }),
        new AbortController().signal,
      ),
  );
  expect(JSON.parse(String(result.content))).toEqual(snapshot);
});

test("workflow_deploy posts assetId, commitSha, entry, and expectedWireHash to the deploy route", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const result = await withFetch(
    (url, init) => {
      seenUrl = url;
      seenBody =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      return new Response(
        JSON.stringify({
          data: {
            deploymentId: "run_1",
            definitionAssetId: "asset_1",
            status: "deployed",
          },
        }),
        { status: 201 },
      );
    },
    () =>
      bundle.run(
        call(WORKFLOW_DEPLOY_TOOL, {
          assetId: "asset_1",
          commitSha: "sha_1",
          entry: "./workflow.ts",
          expectedWireHash: "wire_abc",
          grants: ["email:*/send"],
        }),
        new AbortController().signal,
      ),
  );
  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/asset_1/deploy",
  );
  // `grants` is carried on the approval card via the tool call's own
  // arguments (see @corbits/approvals' headline.ts), not re-sent to the
  // hub — the deploy route only needs the wire hash it re-verifies against.
  expect(seenBody).toEqual({
    commitSha: "sha_1",
    entry: "./workflow.ts",
    expectedWireHash: "wire_abc",
  });
  expect(result.isError).toBe(false);
  expect(result.content).toContain("run_1");
  expect(result.content).toContain("asset_1");
});

test("workflow_deploy rejects a call missing expectedWireHash or grants without calling the hub", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  await withFetch(
    () => {
      throw new Error("must not be called");
    },
    async () => {
      await expect(
        bundle.run(
          call(WORKFLOW_DEPLOY_TOOL, {
            assetId: "asset_1",
            commitSha: "sha_1",
            entry: "./workflow.ts",
          }),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/invalid input/);
    },
  );
});

test("workflow_deploy_preview posts assetId, commitSha, and entry to the preview route and never approval-gates", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  let seenUrl: string | undefined;
  const result = await withFetch(
    (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({
          data: { wireHash: "wire_abc", grants: ["email:*/send"] },
        }),
      );
    },
    () =>
      bundle.run(
        call(WORKFLOW_DEPLOY_PREVIEW_TOOL, {
          assetId: "asset_1",
          commitSha: "sha_1",
          entry: "./workflow.ts",
        }),
        new AbortController().signal,
      ),
  );
  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/asset_1/deploy/preview",
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(String(result.content))).toEqual({
    wireHash: "wire_abc",
    grants: ["email:*/send"],
  });
  expect(
    workflowAuthoringTools.definitions.find(
      (d) => d.name === WORKFLOW_DEPLOY_PREVIEW_TOOL,
    )?.approval,
  ).toBeUndefined();
});

test("an unknown tool name rejects loudly, never a silent no-op", async () => {
  const bundle = workflowAuthoringTools(testEnv());
  await expect(
    bundle.run(call("delete_everything", {}), new AbortController().signal),
  ).rejects.toThrow(/unknown tool/);
});
