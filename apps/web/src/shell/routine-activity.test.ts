// See `routine-activity.ts` for why this resolves no items until a native
// fires equivalent exists.

import { afterEach, describe, expect, test } from "bun:test";

import { listRoutineActivity } from "./routine-activity";

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
