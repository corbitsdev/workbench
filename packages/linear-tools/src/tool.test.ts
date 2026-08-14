import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { LINEAR_LIST_RECENT_ISSUES_TOOL, linearTools } from "./tool";
import type { LinearEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: LINEAR_LIST_RECENT_ISSUES_TOOL,
  arguments: {},
};

function fakeEnv(linearApiKey: string | undefined): LinearEnv {
  return { linearApiKey } as unknown as LinearEnv;
}

test("declares the linear_list_recent_issues tool", () => {
  const bundle = linearTools(fakeEnv("key"));
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LINEAR_LIST_RECENT_ISSUES_TOOL,
  ]);
});

test("degrades to a non-throwing 'not connected' error when no credential is set", async () => {
  const bundle = linearTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way for an empty-string credential", async () => {
  const bundle = linearTools(fakeEnv(""));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
});

test("returns the issues as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: "issue_1",
                identifier: "CL-1",
                title: "Fix the thing",
                updatedAt: "2026-08-12T09:00:00.000Z",
              },
            ],
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const bundle = linearTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({
      issues: [
        {
          id: "issue_1",
          identifier: "CL-1",
          title: "Fix the thing",
          updatedAt: "2026-08-12T09:00:00.000Z",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = linearTools(fakeEnv("key"));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
