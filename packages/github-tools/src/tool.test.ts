import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { GITHUB_ACTIVITY_TOOL, githubTools } from "./tool";
import type { GitHubEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: GITHUB_ACTIVITY_TOOL,
  arguments: { query: "agent workflows" },
};

function fakeEnv(githubApiKey: string | undefined): GitHubEnv {
  return { githubApiKey } as unknown as GitHubEnv;
}

function emptyResponsesFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
    })) as unknown as typeof fetch;
}

test("declares the github_activity tool", () => {
  const bundle = githubTools(fakeEnv(undefined));
  expect(bundle.definitions.map((d) => d.name)).toEqual([GITHUB_ACTIVITY_TOOL]);
});

test("rejects a missing query without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(
      { id: "call_2", name: GITHUB_ACTIVITY_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("works with no credential at all (keyless call succeeds)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyResponsesFetch();
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      items: unknown[];
    };
    expect(parsed.items).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 403 })) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv(undefined));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result the same way with a credential set", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = githubTools(fakeEnv("ghp_test"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
