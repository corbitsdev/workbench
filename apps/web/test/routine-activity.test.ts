// The seam standing in for `@corbits/routines` (not on `main` yet): today it
// maps `@corbits/chat-ui`'s workflow-run listing into `RoutineActivityItem`,
// so the second column gets real bench-scoped activity instead of nothing.

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

describe("listRoutineActivity", () => {
  test("maps a workflow run into a routine activity item", async () => {
    stubRunsFetch([
      {
        id: "run_1",
        tenantId: "tnt_1",
        definitionAssetId: "researcher/workflow.json",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const items = await listRoutineActivity("tnt_1");

    expect(items).toEqual([
      {
        id: "run_1",
        name: "workflow",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("an empty run list is an empty routine list", async () => {
    stubRunsFetch([]);
    expect(await listRoutineActivity("tnt_1")).toEqual([]);
  });
});
