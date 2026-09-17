import { expect, test } from "bun:test";

import {
  authorWorkflow,
  deployWorkflow,
  orderedSourceOfferingIds,
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
      tenantId: "tenant_1",
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

// The deleted `/api/workflow-workflow-authoring/:assetId/deploy` mirror
// resolved this chain server-side from `listVisibleOfferings`, sorted by
// priority. The stock route takes it from the caller, and the stock
// discovery route it is rebuilt from groups its offerings under each
// model — so the flattening has to restore one global priority order
// across models, not preserve the per-model grouping.
test("orderedSourceOfferingIds flattens the discovery response into one priority order across models", () => {
  expect(
    orderedSourceOfferingIds([
      {
        offerings: [
          { offeringId: "off_slow", priority: 30 },
          { offeringId: "off_mid", priority: 20 },
        ],
      },
      { offerings: [{ offeringId: "off_fast", priority: 10 }] },
    ]),
  ).toEqual(["off_fast", "off_mid", "off_slow"]);
});

test("deployWorkflow reads the stock catalog, then posts an asset/source deploy to the stock route", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return String(url).endsWith("/models")
      ? new Response(
          JSON.stringify([
            { offerings: [{ offeringId: "off_2", priority: 20 }] },
            { offerings: [{ offeringId: "off_1", priority: 10 }] },
          ]),
        )
      : new Response(
          JSON.stringify({
            id: "run_1",
            tenantId: "tenant_1",
            definitionAssetId: "asset_1",
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          { status: 201 },
        );
  }) as unknown as typeof fetch;
  const config: WorkflowAuthoringClientConfig = {
    hubWorkflowAuthoringUrl: "https://hub.example.com",
    tenantId: "tenant_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };

  const result = await deployWorkflow(config, {
    assetId: "asset_1",
    commitSha: "sha_1",
    entry: "./workflow.ts",
  });

  expect(result).toEqual({
    deploymentId: "run_1",
    definitionAssetId: "asset_1",
    status: "pending",
  });
  expect(seen[0]?.url).toBe(
    "https://hub.example.com/api/tenants/tenant_1/models",
  );
  expect(seen[1]?.url).toBe(
    "https://hub.example.com/api/tenants/tenant_1/workflows/deployments",
  );
  expect(JSON.parse(String(seen[1]?.init?.body))).toEqual({
    source: {
      kind: "asset",
      assetId: "asset_1",
      package: { format: "source", commitSha: "sha_1" },
    },
    entry: "./workflow.ts",
    sourceOfferingIds: ["off_1", "off_2"],
    defaultSourceOfferingId: "off_1",
  });
  const headers = seen[1]?.init?.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sc-token");
  expect(headers["x-workflow-run-address"]).toBe("run_1@workflow");
});

test("deployWorkflow surfaces the stock error envelope's message", async () => {
  const fetchImpl = (async (url: string | URL) =>
    String(url).endsWith("/models")
      ? new Response(
          JSON.stringify([
            { offerings: [{ offeringId: "off_1", priority: 1 }] },
          ]),
        )
      : new Response(
          JSON.stringify({
            error: { code: "invalid_workflow", message: "entry not found" },
          }),
          { status: 409 },
        )) as unknown as typeof fetch;
  const err = await deployWorkflow(
    {
      hubWorkflowAuthoringUrl: "https://hub.example.com",
      tenantId: "tenant_1",
      sidecarToken: "sc-token",
      address: "run_1@workflow",
      fetchImpl,
    },
    { assetId: "asset_1", commitSha: "sha_1", entry: "./workflow.ts" },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowAuthoringRequestError);
  expect((err as WorkflowAuthoringRequestError).code).toBe("invalid_workflow");
  expect((err as Error).message).toBe("entry not found");
});
