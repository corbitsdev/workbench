import { expect, test } from "bun:test";

import {
  authorWorkflow,
  readWorkflowSource,
  republishWorkflow,
  WorkflowAuthoringRequestError,
  type WorkflowAuthoringClientConfig,
} from "./client";

type Seen = { url: string; init: RequestInit | undefined };

function capture(respond: () => Response): {
  config: WorkflowAuthoringClientConfig;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  return {
    config: {
      hubWorkflowAuthoringUrl: "https://hub.example.com",
      sidecarToken: "sc-token",
      address: "run_1@workflow",
      fetchImpl,
    },
    seen,
  };
}

const FILES = { "package.json": "{}", "workflow.ts": "export default {};" };

test("authorWorkflow posts the tree to /author with the run's bearer token and address", async () => {
  const { config, seen } = capture(
    () =>
      new Response(
        JSON.stringify({
          data: {
            assetId: "asset_1",
            name: "daily-digest",
            commitSha: "sha_1",
          },
        }),
        { status: 201 },
      ),
  );
  const summary = await authorWorkflow(config, {
    name: "daily-digest",
    files: FILES,
  });
  expect(summary).toEqual({
    assetId: "asset_1",
    name: "daily-digest",
    commitSha: "sha_1",
  });
  const [request] = seen;
  expect(request?.url).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/author",
  );
  const headers = request?.init?.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sc-token");
  expect(headers["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    name: "daily-digest",
    files: FILES,
  });
});

test("republishWorkflow forwards expectedHeadSha and surfaces a 409 with the current head", async () => {
  const { config, seen } = capture(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "conflict",
            userMessage: "asset moved",
            refId: "ref_1",
          },
          currentHeadSha: "sha_current",
        }),
        { status: 409 },
      ),
  );
  const err = await republishWorkflow(config, {
    assetId: "asset_1",
    files: FILES,
    expectedHeadSha: "sha_stale",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthoringRequestError);
  expect((err as WorkflowAuthoringRequestError).code).toBe("conflict");
  expect((err as WorkflowAuthoringRequestError).currentHeadSha).toBe(
    "sha_current",
  );
  expect(JSON.parse(String(seen[0]?.init?.body))).toMatchObject({
    expectedHeadSha: "sha_stale",
  });
});

test("readWorkflowSource GETs /:assetId/source and returns the snapshot", async () => {
  const { config, seen } = capture(
    () =>
      new Response(
        JSON.stringify({
          data: {
            assetId: "asset_1",
            name: "daily-digest",
            headSha: "sha_head",
            files: FILES,
          },
        }),
      ),
  );
  const snapshot = await readWorkflowSource(config, "asset_1");
  expect(snapshot.headSha).toBe("sha_head");
  expect(snapshot.files).toEqual(FILES);
  expect(seen[0]?.url).toBe(
    "https://hub.example.com/api/workflow-workflow-authoring/asset_1/source",
  );
  expect(seen[0]?.init?.method).toBeUndefined();
});

test("a hub rejection with an error envelope becomes a WorkflowAuthoringRequestError carrying the hub's message", async () => {
  const { config } = capture(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid",
            userMessage: 'file "../x" may not contain a ".." segment',
            refId: "ref_1",
          },
        }),
        { status: 400 },
      ),
  );
  const err = await authorWorkflow(config, {
    name: "x",
    files: { "../x": "" },
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthoringRequestError);
  expect((err as Error).message).toMatch(/"\.\." segment/);
});

test("a non-envelope failure is an honest error naming the status, never a fabricated result", async () => {
  const { config } = capture(
    () => new Response("", { status: 502, statusText: "Bad Gateway" }),
  );
  await expect(readWorkflowSource(config, "asset_1")).rejects.toThrow(/502/);
});

test("a success body of the wrong shape is rejected", async () => {
  const { config } = capture(
    () => new Response(JSON.stringify({ nonsense: true })),
  );
  await expect(
    authorWorkflow(config, { name: "x", files: FILES }),
  ).rejects.toThrow(/expected shape/);
});
