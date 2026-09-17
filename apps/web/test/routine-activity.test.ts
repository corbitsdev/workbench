// CL-8087: `listRoutineActivity` resolves no items without fetching. The
// `feed=fires` route it used to read is deleted with `@corbits/run-scope`,
// and the native `GET /workflows/runs` listing has no fires equivalent —
// its top-level-only predicate drops every routine fire by construction,
// and its rows carry no routine attribution to compose client-side from.
// So the shell's "Running" band and Mission Control's active-run count
// honestly report no routine activity until a native fires equivalent
// exists, instead of deriving routine activity from top-level deployment
// rows that are not routine fires.

import { afterEach, describe, expect, test } from "bun:test";

import { listRoutineActivity } from "../src/shell/routine-activity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("listRoutineActivity", () => {
  test("resolves no routine activity", async () => {
    await expect(listRoutineActivity()).resolves.toEqual([]);
  });

  test("issues no fetch", async () => {
    let fetched = false;
    globalThis.fetch = ((_input: RequestInfo | URL) => {
      fetched = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;

    await listRoutineActivity();

    expect(fetched).toBe(false);
  });
});
