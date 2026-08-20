// The seam standing in for `@corbits/routines` (not on `main` yet): today it
// maps `listTopLevelRuns`'s server-scoped run listing into
// `RoutineActivityItem`, so the second column gets real bench-scoped
// activity instead of nothing. Folded/chat/task runs never reach this
// module at all — the hub's `/top-level-runs` route already excludes them
// (see `@corbits/folded-runs`'s `scope-routes.ts`), so there is nothing
// left for this seam to filter.

import { afterEach, describe, expect, test } from "bun:test";

import { listRoutineActivity } from "../src/shell/routine-activity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubTopLevelRunsFetch(runs: readonly unknown[]): void {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ data: runs, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

const deploymentRun = {
  id: "run_1",
  definitionId: "wfd_1",
  definitionName: "Researcher",
  tenantId: "tnt_1",
  address: "run_1@tnt1.example",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("listRoutineActivity", () => {
  test("maps a workflow run into a routine activity item", async () => {
    stubTopLevelRunsFetch([deploymentRun]);

    const items = await listRoutineActivity("tnt_1");

    expect(items).toEqual([
      {
        id: "run_1",
        name: "Researcher",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("an empty run list is an empty routine list", async () => {
    stubTopLevelRunsFetch([]);
    expect(await listRoutineActivity("tnt_1")).toEqual([]);
  });
});
