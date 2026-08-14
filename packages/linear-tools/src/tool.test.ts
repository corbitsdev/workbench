import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import { LINEAR_LIST_RECENT_ISSUES_TOOL, linearTools } from "./tool";
import type { LinearEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: LINEAR_LIST_RECENT_ISSUES_TOOL,
  arguments: {},
};

/**
 * A fake `credentials` capability mirroring the REAL provider a Linear
 * binding resolves through in production:
 * `@corbits/credential-providers`'s `http-raw-authorization` plugin, not
 * `@intx/harness`'s Bearer-prefixed `http` provider. Linear's API expects
 * the raw key verbatim in `authorization` (see
 * `@corbits/credential-providers`'s `createHttpRawAuthorizationCredentialProvider`);
 * a bound `secret` resolves to a mediated `fetch` that injects it
 * unprefixed and delegates to `globalThis.fetch`. An unbound handle
 * throws, matching the real gate's "no credential is bound to handle"
 * failure.
 */
function fakeCredentials(secret: string | undefined): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (secret === undefined) {
        return Promise.reject(
          new Error(`no credential is bound to handle "${handle}"`),
        );
      }
      return Promise.resolve({
        kind: "http",
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", secret);
          return fetch(input as string | URL, { ...init, headers });
        },
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): LinearEnv {
  return { credentials } as unknown as LinearEnv;
}

test("declares the linear_list_recent_issues tool", () => {
  const bundle = linearTools(fakeEnv(fakeCredentials("key")));
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LINEAR_LIST_RECENT_ISSUES_TOOL,
  ]);
});

test("degrades to a non-throwing 'not connected' error when no credential is bound", async () => {
  const bundle = linearTools(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way when the step carries no credentials capability at all", async () => {
  const bundle = linearTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("returns the issues as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    expect((init?.headers as Headers | undefined)?.get("authorization")).toBe(
      "key",
    );
    return new Response(
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
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = linearTools(fakeEnv(fakeCredentials("key")));
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
    const bundle = linearTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
