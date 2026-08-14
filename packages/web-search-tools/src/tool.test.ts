import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import { WEB_SEARCH_TOOL, webSearchTools } from "./tool";
import type { WebSearchEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: WEB_SEARCH_TOOL,
  arguments: { query: "agent workflows" },
};

/**
 * A fake `credentials` capability mirroring the platform's own
 * `createCredentialCapability`/`createHttpCredentialProvider` shape: a
 * bound `secret` resolves to a mediated `fetch` that injects a header
 * and delegates to `globalThis.fetch`; an unbound handle throws,
 * matching the real gate's "no credential is bound to handle" failure.
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
          headers.set("x-api-key", secret);
          return fetch(input as string | URL, { ...init, headers });
        },
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): WebSearchEnv {
  return { credentials } as unknown as WebSearchEnv;
}

test("declares the web_search tool", () => {
  const bundle = webSearchTools(fakeEnv(fakeCredentials("key")));
  expect(bundle.definitions.map((d) => d.name)).toEqual([WEB_SEARCH_TOOL]);
});

test("degrades to a non-throwing 'not connected' error when no credential is bound", async () => {
  const bundle = webSearchTools(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way when the step carries no credentials capability at all", async () => {
  const bundle = webSearchTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("rejects a missing query without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      { id: "call_2", name: WEB_SEARCH_TOOL, arguments: {} },
      new AbortController().signal,
    );
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns results as JSON content on a successful call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    expect((init?.headers as Headers | undefined)?.get("x-api-key")).toBe(
      "key",
    );
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Agent workflows explained",
            url: "https://example.test/a",
            publishedDate: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      results: unknown[];
    };
    expect(parsed.results).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = webSearchTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
