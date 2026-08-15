// The seam standing in for `@corbits/routines` (not on `main` yet): today it
// maps `@corbits/chat-ui`'s workflow-run listing into `RoutineActivityItem`,
// so the second column gets real bench-scoped activity instead of nothing.
// Folded/chat run ids are excluded — they self-anchor like deployments and
// would otherwise pollute the "Running" band.

import { afterEach, describe, expect, test } from "bun:test";

import { listRoutineActivity } from "../src/shell/routine-activity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubRunsFetch(runs: readonly unknown[]): void {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(runs), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

const deploymentRun = {
  id: "run_1",
  tenantId: "tnt_1",
  definitionAssetId: "researcher/workflow.json",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const foldedRun = {
  id: "run_channel_host",
  tenantId: "tnt_1",
  definitionAssetId: "run-abc123/workflow.json",
  status: "running",
  createdAt: "2026-01-02T00:00:00.000Z",
};

describe("listRoutineActivity", () => {
  test("maps a workflow run into a routine activity item", async () => {
    stubRunsFetch([deploymentRun]);

    const items = await listRoutineActivity("tnt_1", new Set());

    expect(items).toEqual([
      {
        id: "run_1",
        name: "workflow",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("excludes a folded/chat run by id while keeping a real deployment", async () => {
    stubRunsFetch([deploymentRun, foldedRun]);

    const items = await listRoutineActivity(
      "tnt_1",
      new Set(["run_channel_host"]),
    );

    expect(items.map((item) => item.id)).toEqual(["run_1"]);
  });

  test("an empty run list is an empty routine list", async () => {
    stubRunsFetch([]);
    expect(await listRoutineActivity("tnt_1", new Set())).toEqual([]);
  });
});
